/**
 * scrapers/public-regulatory-warning-letter-sources.js — public warning letter discovery
 *
 * Uses no-key official regulatory pages to collect company/product warning
 * letters that often precede recalls, injunctions, seizures, or press coverage.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const FDA_WARNING_LETTERS_URL = "https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters";
const FDA_DRUG_SAFETY_COMMUNICATIONS_URL = "https://www.fda.gov/drugs/drug-safety-and-availability/drug-safety-communications";
const UK_DRUG_DEVICE_ALERTS_ATOM_URL = "https://www.gov.uk/drug-device-alerts.atom";
const PMDA_POST_MARKETING_SAFETY_RSS_URL = "https://www.pmda.go.jp/rss_006.xml";
const CDSCO_ALERTS_URL = "https://cdsco.gov.in/opencms/opencms/en/Notifications/Alerts/";
const HSA_ANNOUNCEMENTS_URL = "https://www.hsa.gov.sg/announcements/";
const WHO_MEDICAL_PRODUCT_ALERTS_URL = "https://www.who.int/teams/regulation-prequalification/incidents-and-SF/full-list-of-who-medical-product-alerts";
const EMA_WHATS_NEW_URL = "https://www.ema.europa.eu/en/news-events/whats-new";
const DEFAULT_WARNING_LETTER_TARGETS = [
  { key: "fda_warning_letters", name: "FDA Warning Letters", url: FDA_WARNING_LETTERS_URL, kind: "fda_warning_letters_html" },
  { key: "fda_drug_safety_communications", name: "FDA Drug Safety Communications", url: FDA_DRUG_SAFETY_COMMUNICATIONS_URL, kind: "fda_drug_safety_communications_html" },
  { key: "uk_drug_device_alerts", name: "UK Drug and Device Alerts", url: UK_DRUG_DEVICE_ALERTS_ATOM_URL, kind: "uk_drug_device_alerts_atom" },
  { key: "pmda_post_marketing_safety", name: "PMDA Post-marketing Safety Measures", url: PMDA_POST_MARKETING_SAFETY_RSS_URL, kind: "pmda_post_marketing_safety_rss" },
  { key: "cdsco_alerts", name: "CDSCO Alerts", url: CDSCO_ALERTS_URL, kind: "cdsco_alerts_html" },
  { key: "hsa_announcements", name: "Singapore HSA Announcements", url: HSA_ANNOUNCEMENTS_URL, kind: "hsa_announcements_html" },
  { key: "who_medical_product_alerts", name: "WHO Medical Product Alerts", url: WHO_MEDICAL_PRODUCT_ALERTS_URL, kind: "who_medical_product_alerts_html" },
  { key: "ema_whats_new", name: "EMA What's New", url: EMA_WHATS_NEW_URL, kind: "ema_whats_new_html" },
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

function decodeXmlText(value = "", max = 1200) {
  return cleanText(String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1"), max);
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(40, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const cleaned = cleanText(value, 80);
  const compact = cleaned.replace(/[^0-9]/g, "");
  const normalized = compact.length === 8 && /^\d{8}$/.test(compact)
    ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
    : cleaned;
  const time = new Date(normalized || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeDmySlashDate(value = "") {
  const clean = cleanText(value, 80);
  const match = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return normalizeDate(clean);
  const formatted = `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}T00:00:00.000Z`;
  const time = new Date(formatted).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function normalizeTargets(targets = DEFAULT_WARNING_LETTER_TARGETS) {
  const requested = Array.isArray(targets) && targets.length ? targets : DEFAULT_WARNING_LETTER_TARGETS;
  const byKey = new Map(DEFAULT_WARNING_LETTER_TARGETS.map(target => [target.key, target]));
  return requested
    .map(target => {
      if (typeof target === "string") return byKey.get(target) || { key: target, name: target, url: target, kind: "custom" };
      return target;
    })
    .filter(target => target?.url);
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeWarningLetterKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeWarningLetterKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeWarningLetterKeywordText(text);
  return keywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeWarningLetterKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function regulatoryWarningLetterRiskLevel({ subject = "", excerpt = "", office = "", title = "" } = {}) {
  const text = `${title} ${subject} ${excerpt} ${office}`.toLowerCase();
  if (/warning letter|adulterated|misbranded|unapproved|cgmp|qsr|insanitary|violat|injunction|seizure|recall|serious|risk|fraud|illegal|contaminat|allergen|警告信|違規|违规|未批准|摻假|掺假|召回|嚴重|严重|欺詐|欺诈/i.test(text)) return "high";
  if (/inspection|compliance|response letter|closeout|office|center|監管|监管|合規|合规|檢查|检查/i.test(text)) return "medium";
  return "low";
}

function drugSafetyCommunicationRiskLevel({ title = "" } = {}) {
  const text = cleanText(title, 800).toLowerCase();
  if (/boxed warning|death|serious|severe|injury|liver injury|kidney injury|anaphylaxis|seizure|heart|cancer|blood clots|withdraw|withdrawal|removed from market|contraindicat|risk of death|class\s*[123]\s+medicines\s+recall|recall|defect|sterility|obstruction|perforation|foreign particulate|disconnection|安全|死亡|嚴重|严重|損傷|损伤|撤市|警告/i.test(text)) return "high";
  if (/warning|warn|risk|safety|labeling changes|requires|recommends|cautions|evaluation|monitoring|removal|field safety notice|medicines defect notification|安全通訊|安全通讯|風險|风险|標籤|标签/i.test(text)) return "medium";
  return "low";
}

function cdscoAlertRiskLevel({ title = "" } = {}) {
  const text = cleanText(title, 800).toLowerCase();
  if (/spurious|not standard quality|\bnsq\b|alert|recall|theft|adulterat|counterfeit|falsified|medical device|vaccine|cosmetic|drug product|quality|serious|injury|unsafe|risk|假|劣|召回|警示|醫療器械|医疗器械/i.test(text)) return "high";
  if (/circular|availability|corrigendum|notice|list|regulatory|licensing|study centre/i.test(text)) return "medium";
  return "low";
}

function hsaAnnouncementRiskLevel({ title = "", category = "", summary = "", productType = "" } = {}) {
  const text = `${title} ${category} ${summary} ${productType}`.toLowerCase();
  if (/product recall|safety alert|field safety notice|dear healthcare professional|serious adverse|harm your health|unsafe|recall|adverse effect|contaminat|adulterat|unauthori[sz]ed|dubious|mercury|steroid|sibutramine|poison|toxic|defect|counterfeit|falsified|risk|危害|召回|警示|不良反應|不良反应/i.test(text)) return "high";
  if (/consumer safety|regulatory update|health product|medical device|therapeutic product|traditional medicine|cosmetic|supplement|safety|warning|advisory|update/i.test(text)) return "medium";
  return "low";
}

function whoMedicalProductAlertRiskLevel({ title = "", tag = "" } = {}) {
  const text = `${title} ${tag}`.toLowerCase();
  if (/substandard|falsified|counterfeit|contaminat|adverse reactions?|death|serious|toxic|poison|ethylene glycol|diethylene glycol|propylene glycol|fentanyl|oxycodone|vaccine|injection|paediatric|pediatric|syrup|liquid dosage|medical product alert|unsafe|risk/i.test(text)) return "high";
  if (/information notice|ivd|in-vitro|diagnostic|medical device|medicine|drug|alert|notice|product/i.test(text)) return "medium";
  return "low";
}

function emaWhatsNewRiskLevel({ title = "", contentType = "", metadata = "" } = {}) {
  const text = `${title} ${contentType} ${metadata}`.toLowerCase();
  if (/prac|pharmacovigilance|safety signal|signals adopted|new product information wording|risk management|restriction|suspension|withdraw|withdrawal|revocation|referral|shortage|medicine shortages?|medical devices?|vaccine|recall|defect|serious|death|adverse|contraindicat|warning|risk|安全|風險|风险/i.test(text)) return "high";
  if (/psusa|post-authorisation|medicine|document|news|herbal|chmp|cvmp|product information|variation|assessment|guideline|regulatory/i.test(text)) return "medium";
  return "low";
}

function fdaWarningLettersSearchUrl(keyword = "", { recentDays = "" } = {}) {
  const params = new URLSearchParams({ search_api_fulltext: cleanText(keyword, 120) });
  if (recentDays) params.set("field_letter_issue_datetime", String(recentDays));
  return `${FDA_WARNING_LETTERS_URL}?${params.toString()}`;
}

function fdaDrugSafetyCommunicationsSearchUrl() {
  return FDA_DRUG_SAFETY_COMMUNICATIONS_URL;
}

function ukDrugDeviceAlertsUrl() {
  return UK_DRUG_DEVICE_ALERTS_ATOM_URL;
}

function xmlTagValue(block = "", tag = "", max = 1200) {
  const match = String(block || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXmlText(match?.[1] || "", max);
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
      id: xmlTagValue(block, "id", 900),
      updated: xmlTagValue(block, "updated", 160),
      link: cleanText(link, 900),
      title: xmlTagValue(block, "title", 520),
      summary: xmlTagValue(block, "summary", 1800),
    });
  }
  return out;
}

function rss1Items(xml = "") {
  const source = String(xml || "");
  const out = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(source)) !== null) {
    const block = match[1] || "";
    out.push({
      title: xmlTagValue(block, "title", 520),
      link: xmlTagValue(block, "link", 900),
      creator: xmlTagValue(block, "dc:creator", 260),
      date: xmlTagValue(block, "dc:date", 160),
      description: xmlTagValue(block, "description", 1800),
    });
  }
  return out;
}

function absoluteFdaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.fda.gov/${value.replace(/^\/+/, "")}`;
}

function absoluteCdscoUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://cdsco.gov.in/${value.replace(/^\/+/, "")}`;
}

function absoluteHsaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.hsa.gov.sg/${value.replace(/^\/+/, "")}`;
}

function absoluteWhoUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.who.int/${value.replace(/^\/+/, "")}`;
}

function absoluteEmaUrl(url = "") {
  const value = cleanText(url, 900);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.ema.europa.eu/${value.replace(/^\/+/, "")}`;
}

function normalizeWarningLetterDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeWarningLetterDedupeUrl(embedded);
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

function warningLetterDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const source = cleanText(metrics.source || metrics.warning_record_source || "regulatory-warning", 140).toLowerCase();
  const urlKey = normalizeWarningLetterDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  const recordId = cleanText(metrics.warning_record_id || "", 180);
  if (recordId) return `${source}:record:${recordId}`.toLowerCase();
  return [
    source,
    cleanText(metrics.warning_subject || item.title || "", 320),
    cleanText(metrics.warning_letter_date || item.publishedAt || "", 80),
  ].filter(Boolean).join(":").toLowerCase();
}

function warningLetterKeywordMatchSource(item = {}, keyword = "") {
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["record_source", item.metrics?.warning_record_source],
    ["subject", item.metrics?.warning_subject],
    ["summary", item.metrics?.warning_summary],
    ["office", item.metrics?.warning_issuing_office],
    ["record_id", item.metrics?.warning_record_id],
  ];
  return fields.find(([, value]) => textMatchesKeyword(value, keyword))?.[0] || "search_query";
}

function warningLetterKeywordDiagnostics(item = {}, keyword = "") {
  return {
    warning_letter_matched_keyword: cleanText(keyword, 160),
    warning_letter_keyword_match_source: warningLetterKeywordMatchSource(item, keyword),
  };
}

function warningLetterRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = cleanText([
    item.title,
    item.content,
    item.author,
    item.evidenceType,
    metrics.warning_record_source,
    metrics.warning_record_type,
    metrics.warning_company,
    metrics.warning_subject,
    metrics.warning_issuing_office,
    metrics.warning_summary,
    metrics.warning_product,
    metrics.warning_product_type,
    metrics.warning_tag,
    metrics.warning_content_type,
    metrics.warning_substance,
    metrics.source_weight_tier,
  ].filter(Boolean).join(" "), 8000).toLowerCase();
  const reasons = [];
  let score = /global-public-health-alert|regulatory-safety-communication|regulatory-warning-letter/i.test(String(metrics.source_weight_tier || "")) ? 16 : 10;
  const out = {};
  const termMatches = (terms = []) => {
    const source = normalizeWarningLetterKeywordText(text);
    return terms.filter(term => {
      const needle = normalizeWarningLetterKeywordText(term);
      return needle && source.includes(needle);
    });
  };
  const evidenceTerms = termMatches([
    "warning letter", "inspection", "violation", "significant violations", "office", "subject", "product", "safety communication", "medical product alert",
    "警告信", "檢查", "检查", "違規", "违规", "重大違規", "重大违规", "辦公室", "办公室", "主旨", "產品", "产品", "安全通訊", "安全通讯", "醫療產品警示", "医疗产品警示",
  ]);
  const complianceTerms = termMatches([
    "corrective action", "response required", "within 15 working days", "cease distribution", "stop sale", "recall", "seizure", "injunction", "remediation", "risk management",
    "整改", "改善措施", "要求回覆", "要求回复", "15個工作日", "15个工作日", "停止銷售", "停止销售", "停止分銷", "停止分销", "召回", "查封", "禁令", "補救", "补救", "風險管理", "风险管理",
  ]);
  const scopeTerms = termMatches([
    "public health", "patients", "consumers", "healthcare professionals", "global", "international", "market", "product information", "labeling", "all lots",
    "公共健康", "公共衛生", "公共卫生", "患者", "消費者", "消费者", "醫療專業人員", "医疗专业人员", "全球", "國際", "国际", "市場", "市场", "產品資訊", "产品信息", "標籤", "标签", "所有批次",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("warning_letter_official_signal", "official regulator or public-health source", /fda|mhra|pmda|cdsco|hsa|who|ema|regulatory|authority|agency|監管|监管|官方/i.test(text), 6);
  addSignal("warning_letter_warning_signal", "warning letter or regulatory warning", /warning letter|警告信|warning|warn|違規|违规|violation|violat/i.test(text), 14);
  addSignal("warning_letter_safety_communication_signal", "safety communication, alert, notice, or pharmacovigilance update", /safety communication|safety alert|medical product alert|drug safety|field safety notice|dear healthcare professional|pharmacovigilance|prac|安全通訊|安全通讯|安全警示|警示/i.test(text), 14);
  addSignal("warning_letter_recall_signal", "recall, withdrawal, or market removal", /recall|withdraw|withdrawal|removed from market|suspension|class\s*[123]\s+medicines\s+recall|召回|撤市|下架|暫停|暂停/i.test(text), 16);
  addSignal("warning_letter_contamination_adulteration_signal", "contamination, adulteration, sterility, or defect concern", /contaminat|adulterat|insanitary|sterility|sterile|defect|foreign particulate|allergen|cgmp|qsr|quality|摻假|掺假|污染|無菌|无菌|缺陷|過敏原|过敏原|質量|质量/i.test(text), 14);
  addSignal("warning_letter_unapproved_misbranded_signal", "unapproved, misbranded, illegal, or labeling concern", /unapproved|misbrand|illegal|labeling|label changes|new product information wording|未批准|標籤|标签|錯標|错标|非法/i.test(text), 14);
  addSignal("warning_letter_serious_adverse_event_signal", "serious adverse event, injury, death, or organ risk", /serious|severe|death|injury|liver injury|kidney injury|heart|cancer|blood clots|anaphylaxis|seizure|adverse|toxic|poison|死亡|嚴重|严重|損傷|损伤|不良反應|不良反应|中毒/i.test(text), 18);
  addSignal("warning_letter_pharmacovigilance_signal", "pharmacovigilance, PRAC, signal, or product-information update", /pharmacovigilance|prac|safety signal|signals adopted|psusa|risk management|product information|藥物警戒|药物警戒|風險信號|风险信号/i.test(text), 10);
  addSignal("warning_letter_counterfeit_falsified_signal", "counterfeit, falsified, spurious, substandard, or theft concern", /counterfeit|falsified|substandard|spurious|theft|fake|dubious|unknown sources|假冒|偽造|伪造|劣藥|劣药|盜竊|盗窃|可疑來源|可疑来源/i.test(text), 16);
  addSignal("warning_letter_global_health_alert_signal", "global health or cross-border medical-product alert", /world health organization|who medical product alert|global-public-health-alert|ema|pmda|hsa|cdsco|全球|公共衛生|公共卫生/i.test(text), 8);
  addSignal("warning_letter_evidence_language_signal", "inspection, violation, warning, subject, or product evidence language", evidenceTerms.length > 0, 10);
  addSignal("warning_letter_compliance_action_signal", "corrective action, response, stop-sale, seizure, or injunction language", complianceTerms.length > 0, 10);
  addSignal("warning_letter_scope_language_signal", "public health, patient, consumer, market, labeling, or global scope language", scopeTerms.length > 0, 8);

  const semanticSignals = [
    out.warning_letter_official_signal,
    out.warning_letter_warning_signal,
    out.warning_letter_safety_communication_signal,
    out.warning_letter_recall_signal,
    out.warning_letter_contamination_adulteration_signal,
    out.warning_letter_unapproved_misbranded_signal,
    out.warning_letter_serious_adverse_event_signal,
    out.warning_letter_pharmacovigilance_signal,
    out.warning_letter_counterfeit_falsified_signal,
    out.warning_letter_global_health_alert_signal,
    out.warning_letter_evidence_language_signal,
    out.warning_letter_compliance_action_signal,
    out.warning_letter_scope_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "warning_letter_complete_regulatory_narrative_signal",
    "complete regulatory warning narrative",
    semanticSignals >= 5
      && out.warning_letter_official_signal
      && (out.warning_letter_warning_signal || out.warning_letter_safety_communication_signal)
      && (out.warning_letter_unapproved_misbranded_signal || out.warning_letter_contamination_adulteration_signal || out.warning_letter_serious_adverse_event_signal || out.warning_letter_counterfeit_falsified_signal)
      && (out.warning_letter_compliance_action_signal || out.warning_letter_scope_language_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    warning_letter_risk_score: boundedScore,
    warning_letter_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    warning_letter_signal_count: signalFields.length,
    warning_letter_semantic_signal_count: semanticSignals,
    warning_letter_signal_reasons: [...new Set(reasons)].slice(0, 12),
    warning_letter_evidence_terms: evidenceTerms,
    warning_letter_compliance_terms: complianceTerms,
    warning_letter_scope_terms: scopeTerms,
  };
}

function emaWhatsNewUrls(baseUrl = EMA_WHATS_NEW_URL) {
  const root = cleanText(baseUrl || EMA_WHATS_NEW_URL, 900).replace(/\/+$/, "");
  return [root, `${root}/last-month`, `${root}/two-months-ago`];
}

function extractCells(rowHtml = "") {
  return [...String(rowHtml || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1] || "");
}

function extractTime(cellHtml = "") {
  const datetime = (String(cellHtml || "").match(/<time[^>]+datetime=["']([^"']+)["']/i) || [])[1] || "";
  return normalizeDate(datetime) || normalizeDate(cleanText(cellHtml, 80));
}

function parseFdaWarningLetterResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const cells = extractCells(match[1]);
    if (cells.length < 5) continue;
    const postedAt = extractTime(cells[0]);
    const letterDate = extractTime(cells[1]);
    const companyCell = cells[2] || "";
    const linkMatch = companyCell.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const company = cleanText(linkMatch?.[2] || companyCell, 240);
    const url = absoluteFdaUrl(linkMatch?.[1] || "");
    const office = cleanText(cells[3], 260);
    const subject = cleanText(cells[4], 360);
    const responseLetter = cleanText(cells[5], 180);
    const closeoutLetter = cleanText(cells[6], 180);
    const excerpt = cleanText(cells[7], 1000);
    const searchable = [company, office, subject, responseLetter, closeoutLetter, excerpt].join(" ");
    if (!company || !textMatchesKeyword(searchable, keyword)) continue;
    const publishedAt = postedAt || letterDate || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const dedupeKey = url || `${company}:${letterDate}:${subject}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      url: url || FDA_WARNING_LETTERS_URL,
      title: `FDA warning letter: ${company}${subject ? ` - ${subject}` : ""}`,
      content: [
        letterDate ? `Letter issue date: ${letterDate}.` : "",
        office ? `Issuing office: ${office}.` : "",
        subject ? `Subject: ${subject}.` : "",
        responseLetter ? `Response letter: ${responseLetter}.` : "",
        closeoutLetter ? `Closeout letter: ${closeoutLetter}.` : "",
        excerpt,
      ].filter(Boolean).join(" "),
      author: "U.S. Food and Drug Administration",
      publishedAt,
      riskLevel: regulatoryWarningLetterRiskLevel({ subject, excerpt, office, title: company }),
      metrics: {
        source: "fda_warning_letters",
        source_family: "official",
        source_kind: "public_regulatory_warning_letter",
        collection_mode: "fda_public_warning_letters_html",
        warning_record_source: "FDA Warning Letters",
        warning_record_type: "fda-warning-letter",
        warning_company: company,
        warning_subject: subject,
        warning_issuing_office: office,
        warning_letter_date: letterDate,
        warning_response_letter: responseLetter,
        warning_closeout_letter: closeoutLetter,
        source_weight_tier: "regulatory-warning-letter",
      },
    });
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function parseFdaDrugSafetyCommunicationResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const cells = extractCells(match[1]);
    if (cells.length < 2) continue;
    const communicationDate = normalizeDate(cleanText(cells[0], 80));
    const titleCell = cells[1] || "";
    const linkMatch = titleCell.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = cleanText(linkMatch?.[2] || titleCell, 420);
    const url = absoluteFdaUrl(linkMatch?.[1] || "");
    const searchable = [title, url].join(" ");
    if (!title || !url || !textMatchesKeyword(searchable, keyword)) continue;
    const publishedAt = communicationDate || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const dedupeKey = url || `${title}:${publishedAt}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      url,
      title: `FDA drug safety communication: ${title}`,
      content: [
        communicationDate ? `Communication date: ${communicationDate}.` : "",
        `Title: ${title}.`,
      ].filter(Boolean).join(" "),
      author: "U.S. Food and Drug Administration",
      publishedAt,
      riskLevel: drugSafetyCommunicationRiskLevel({ title }),
      evidenceType: "public_regulatory_safety_communication",
      metrics: {
        source: "fda_drug_safety_communications",
        source_family: "official",
        source_kind: "public_regulatory_safety_communication",
        collection_mode: "fda_public_drug_safety_communications_html",
        warning_record_source: "FDA Drug Safety Communications",
        warning_record_type: "fda-drug-safety-communication",
        warning_company: "",
        warning_subject: title,
        warning_issuing_office: "Center for Drug Evaluation and Research (CDER)",
        warning_letter_date: communicationDate,
        warning_response_letter: "",
        warning_closeout_letter: "",
        source_weight_tier: "regulatory-safety-communication",
      },
    });
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function ukDrugDeviceAlertType(title = "") {
  const clean = cleanText(title, 260);
  if (/class\s*\d+\s+medicines\s+recall/i.test(clean)) return "medicines-recall";
  if (/medicines\s+defect\s+notification/i.test(clean)) return "medicines-defect-notification";
  if (/field\s+safety\s+notice/i.test(clean)) return "field-safety-notice";
  if (/safety\s+roundup/i.test(clean)) return "safety-roundup";
  if (/safety\s+information/i.test(clean)) return "safety-information";
  return "drug-device-alert";
}

function ukDrugDeviceAlertRecordId(title = "", id = "") {
  const fromTitle = (cleanText(title, 520).match(/\(([A-Z]{2,6}\/\d{4}\/\d{2,4})\)\s*$/i) || [])[1] || "";
  if (fromTitle) return cleanText(fromTitle, 80);
  const fromTitleAlt = (cleanText(title, 520).match(/\b([A-Z]{2}\(\d{2}\)A\/\d{1,3})\b/i) || [])[1] || "";
  if (fromTitleAlt) return cleanText(fromTitleAlt, 80);
  return cleanText(id, 220);
}

function normalizeUkDrugDeviceAlert(row = {}, keyword = "") {
  const title = cleanText(row.title, 520);
  const summary = cleanText(row.summary, 1800);
  const url = cleanText(row.link, 900) || UK_DRUG_DEVICE_ALERTS_ATOM_URL;
  const alertType = ukDrugDeviceAlertType(title);
  const recordId = ukDrugDeviceAlertRecordId(title, row.id);
  const subject = cleanText(title
    .replace(/^Class\s*\d+\s+Medicines\s+Recall\s*:\s*/i, "")
    .replace(/^Class\s*\d+\s+Medicines\s+Defect\s+Notification\s*:\s*/i, "")
    .replace(/^Field\s+Safety\s+Notices?\s*:\s*/i, "")
    .replace(/\s*\([A-Z]{2,6}\/\d{4}\/\d{2,4}\)\s*$/i, ""), 420);
  const searchable = [title, subject, summary, recordId, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.updated) || new Date().toISOString();
  return {
    url,
    title: `UK drug/device alert: ${subject || title}`,
    content: [
      subject ? `Subject: ${subject}.` : "",
      alertType ? `Alert type: ${alertType}.` : "",
      recordId ? `Record ID: ${recordId}.` : "",
      summary,
    ].filter(Boolean).join(" "),
    author: "UK Medicines and Healthcare products Regulatory Agency",
    publishedAt,
    riskLevel: drugSafetyCommunicationRiskLevel({ title: `${title} ${summary}` }),
    evidenceType: "public_regulatory_safety_communication",
    metrics: {
      source: "uk_drug_device_alerts",
      source_family: "official",
      source_kind: "public_regulatory_safety_communication",
      collection_mode: "uk_gov_public_drug_device_alerts_atom",
      warning_record_source: "UK Drug and Device Alerts",
      warning_record_type: alertType,
      warning_company: "",
      warning_subject: subject || title,
      warning_issuing_office: "Medicines and Healthcare products Regulatory Agency (MHRA)",
      warning_letter_date: publishedAt,
      warning_response_letter: "",
      warning_closeout_letter: "",
      warning_record_id: recordId,
      warning_summary: summary,
      source_weight_tier: "regulatory-safety-communication",
    },
  };
}

function parseUkDrugDeviceAlertResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of atomItems(xml)) {
    const item = normalizeUkDrugDeviceAlert(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `uk-drug-device-alert:${item.metrics.warning_record_id || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function pmdaSafetyRecordType(title = "") {
  const clean = cleanText(title, 260);
  if (/revisions?\s+of\s+precautions/i.test(clean)) return "revision-of-precautions";
  if (/risk\s+communications?/i.test(clean)) return "risk-communication";
  if (/medical\s+safety\s+information/i.test(clean)) return "medical-safety-information";
  if (/proper\s+use\s+of\s+drugs|properly-use/i.test(clean)) return "proper-use-alert";
  if (/yellow\s+letter|blue\s+letter/i.test(clean)) return "yellow-blue-letter";
  return "post-marketing-safety-measure";
}

function normalizePmdaSafetyMeasure(row = {}, keyword = "") {
  const title = cleanText(row.title, 520);
  const url = cleanText(row.link, 900) || PMDA_POST_MARKETING_SAFETY_RSS_URL;
  const creator = cleanText(row.creator || "Pharmaceuticals and Medical Devices Agency", 260);
  const description = cleanText(row.description, 1800);
  const recordType = pmdaSafetyRecordType(title);
  const subject = cleanText(title
    .replace(/\s+posted$/i, "")
    .replace(/^PMDA\s+/i, ""), 420);
  const searchable = [title, subject, description, creator, url].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDate(row.date) || new Date().toISOString();
  return {
    url,
    title: `PMDA safety measure: ${subject || title}`,
    content: [
      subject ? `Subject: ${subject}.` : "",
      recordType ? `Record type: ${recordType}.` : "",
      creator ? `Agency: ${creator}.` : "",
      description,
    ].filter(Boolean).join(" "),
    author: "Pharmaceuticals and Medical Devices Agency",
    publishedAt,
    riskLevel: drugSafetyCommunicationRiskLevel({ title: `${title} ${description}` }),
    evidenceType: "public_regulatory_safety_communication",
    metrics: {
      source: "pmda_post_marketing_safety",
      source_family: "official",
      source_kind: "public_regulatory_safety_communication",
      collection_mode: "pmda_public_post_marketing_safety_rss",
      warning_record_source: "PMDA Post-marketing Safety Measures",
      warning_record_type: recordType,
      warning_company: "",
      warning_subject: subject || title,
      warning_issuing_office: creator,
      warning_letter_date: publishedAt,
      warning_response_letter: "",
      warning_closeout_letter: "",
      warning_summary: description || title,
      source_weight_tier: "regulatory-safety-communication",
    },
  };
}

function parsePmdaSafetyMeasureResults(xml = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rss1Items(xml)) {
    const item = normalizePmdaSafetyMeasure(row, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `pmda-safety:${item.url || `${item.title}:${item.publishedAt}`}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function normalizeCdscoAlertRow(cells = [], keyword = "") {
  if (cells.length < 5) return null;
  const serial = cleanText(cells[0], 40);
  const title = cleanText(cells[1], 520);
  const releaseDate = normalizeDate(cleanText(cells[2], 120));
  const linkMatch = String(cells[3] || "").match(/<a[^>]+href=["']([^"']+)["']/i);
  const url = absoluteCdscoUrl(linkMatch?.[1] || "");
  const pdfSize = cleanText(cells[4], 80);
  const searchable = [serial, title, releaseDate, url, pdfSize].join(" ");
  if (!title || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = releaseDate || new Date().toISOString();
  return {
    url: url || CDSCO_ALERTS_URL,
    title: `CDSCO alert: ${title}`,
    content: [
      releaseDate ? `Release date: ${releaseDate}.` : "",
      serial ? `Serial: ${serial}.` : "",
      pdfSize ? `PDF size: ${pdfSize}.` : "",
      `Title: ${title}.`,
    ].filter(Boolean).join(" "),
    author: "Central Drugs Standard Control Organisation",
    publishedAt,
    riskLevel: cdscoAlertRiskLevel({ title }),
    evidenceType: "public_regulatory_safety_communication",
    metrics: {
      source: "cdsco_alerts",
      source_family: "official",
      source_kind: "public_regulatory_safety_communication",
      collection_mode: "cdsco_public_alerts_html",
      warning_record_source: "CDSCO Alerts",
      warning_record_type: "cdsco-alert",
      warning_company: "",
      warning_subject: title,
      warning_issuing_office: "Central Drugs Standard Control Organisation",
      warning_letter_date: publishedAt,
      warning_response_letter: "",
      warning_closeout_letter: "",
      warning_record_id: serial,
      warning_pdf_size: pdfSize,
      source_weight_tier: "regulatory-safety-communication",
    },
  };
}

function parseCdscoAlertResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const cells = extractCells(match[1]);
    const item = normalizeCdscoAlertRow(cells, keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `cdsco-alert:${item.url || `${item.metrics.warning_record_id}:${item.title}:${item.publishedAt}`}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function extractHsaAnnouncementTags(block = "") {
  const tags = [];
  const regex = /<p\b[^>]*class=["'][^"']*prose-label-sm-medium[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = regex.exec(String(block || ""))) !== null) {
    const tag = cleanText(match[1], 160);
    if (tag) tags.push(tag);
  }
  return [...new Set(tags)];
}

function hsaAnnouncementType(category = "", title = "") {
  const clean = `${cleanText(category, 180)} ${cleanText(title, 260)}`;
  if (/product recalls?/i.test(clean)) return "product-recall";
  if (/safety alerts?/i.test(clean)) return "safety-alert";
  if (/field safety notices?/i.test(clean)) return "field-safety-notice";
  if (/dear healthcare professional letters?/i.test(clean)) return "dear-healthcare-professional-letter";
  if (/consumer safety articles?/i.test(clean)) return "consumer-safety-article";
  if (/regulatory updates?/i.test(clean)) return "regulatory-update";
  return "hsa-announcement";
}

function normalizeHsaDate(value = "") {
  const clean = cleanText(value, 120);
  const match = clean.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return normalizeDate(clean);
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
  if (!month) return normalizeDate(clean);
  return new Date(`${match[3]}-${month}-${String(match[1]).padStart(2, "0")}T00:00:00.000Z`).toISOString();
}

function extractHsaAnnouncementCategory(block = "") {
  const regex = /<p\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  let category = "";
  while ((match = regex.exec(String(block || ""))) !== null) {
    const className = match[1] || "";
    if (!/\bprose-label-md\b/.test(className) || !/\btext-base-content-subtle\b/.test(className) || /\bprose-label-md-regular\b/.test(className)) continue;
    category = cleanText(match[2], 180) || category;
  }
  return category;
}

function normalizeHsaAnnouncementBlock(block = "", keyword = "") {
  const href = (String(block || "").match(/\bhref=["']([^"']*\/announcements\/[^"']+)["']/i) || [])[1] || "";
  const url = absoluteHsaUrl(href);
  const date = cleanText((String(block || "").match(/<p\b[^>]*prose-label-md-regular[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "", 120);
  const title = cleanText((String(block || "").match(/<span\b[^>]*\btitle=["']([^"']+)["'][^>]*>/i) || [])[1] || "", 520)
    || cleanText((String(block || "").match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || "", 520);
  const summary = cleanText((String(block || "").match(/<p\b[^>]*prose-body-base[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "", 1800);
  const category = extractHsaAnnouncementCategory(block);
  const tags = extractHsaAnnouncementTags(block);
  const productType = tags.join(", ");
  const searchable = [title, summary, category, productType, url].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeHsaDate(date) || new Date().toISOString();
  const recordType = hsaAnnouncementType(category, title);
  return {
    url,
    title: `HSA announcement: ${title}`,
    content: [
      date ? `Announcement date: ${date}.` : "",
      category ? `Category: ${category}.` : "",
      productType ? `Product type: ${productType}.` : "",
      summary,
    ].filter(Boolean).join(" "),
    author: "Health Sciences Authority Singapore",
    publishedAt,
    riskLevel: hsaAnnouncementRiskLevel({ title, category, summary, productType }),
    evidenceType: "public_regulatory_safety_communication",
    metrics: {
      source: "hsa_announcements",
      source_family: "official",
      source_kind: "public_regulatory_safety_communication",
      collection_mode: "hsa_public_announcements_html",
      warning_record_source: "Singapore HSA Announcements",
      warning_record_type: recordType,
      warning_company: "",
      warning_subject: title,
      warning_issuing_office: "Health Sciences Authority (Singapore)",
      warning_letter_date: publishedAt,
      warning_response_letter: "",
      warning_closeout_letter: "",
      warning_product_type: productType,
      warning_summary: summary || title,
      source_weight_tier: "regulatory-safety-communication",
    },
  };
}

function parseHsaAnnouncementResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const blockRegex = /<a\b[^>]*href=["'][^"']*\/announcements\/[^"']+["'][^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const item = normalizeHsaAnnouncementBlock(match[0], keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `hsa-announcement:${item.url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function whoMedicalProductAlertRecordType(title = "") {
  const clean = cleanText(title, 520).toLowerCase();
  if (/information notice|ivd|in-vitro|diagnostic/i.test(clean)) return "who-information-notice";
  if (/substandard/.test(clean)) return "who-substandard-medical-product-alert";
  if (/falsified|counterfeit/.test(clean)) return "who-falsified-medical-product-alert";
  if (/contaminat/.test(clean)) return "who-contaminated-medical-product-alert";
  return "who-medical-product-alert";
}

function extractWhoAlertNumber(title = "") {
  return cleanText((cleanText(title, 520).match(/(?:Medical Product Alert|Alert)\s*N[°ºo]?\s*([0-9]+\/[0-9]{4})/i) || [])[1] || "", 80);
}

function extractWhoAlertProduct(title = "") {
  const clean = cleanText(title, 520)
    .replace(/^Medical Product Alert\s*N[°ºo]?\s*[0-9]+\/[0-9]{4}\s*:\s*/i, "")
    .replace(/^WHO Information Notice\s+(?:for\s+)?/i, "")
    .replace(/^WHO information notice\s+(?:for\s+)?/i, "");
  return cleanText(clean, 360);
}

function normalizeWhoMedicalProductAlertBlock(block = "", keyword = "") {
  const rawBlock = String(block || "");
  const linkMatch = rawBlock.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*aria-label=["']([^"']+)["'][^>]*>/i)
    || rawBlock.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  const url = absoluteWhoUrl(linkMatch?.[1] || "");
  const title = cleanText((rawBlock.match(/<p\b[^>]*class=["'][^"']*\bheading\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1] || linkMatch?.[2] || "", 620);
  const dateText = cleanText((rawBlock.match(/<span\b[^>]*class=["'][^"']*\btimestamp\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "", 120);
  const tag = cleanText((rawBlock.match(/<div\b[^>]*class=["'][^"']*\bsf-tags-list-item\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "", 160);
  const recordId = extractWhoAlertNumber(title);
  const subject = extractWhoAlertProduct(title);
  const recordType = whoMedicalProductAlertRecordType(title);
  const searchable = [title, subject, tag, recordId, url].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeHsaDate(dateText) || new Date().toISOString();
  return {
    url,
    title: `WHO medical product alert: ${subject || title}`,
    content: [
      dateText ? `Alert date: ${dateText}.` : "",
      recordId ? `Alert number: ${recordId}.` : "",
      tag ? `Tag: ${tag}.` : "",
      subject ? `Subject: ${subject}.` : "",
      `Title: ${title}.`,
    ].filter(Boolean).join(" "),
    author: "World Health Organization",
    publishedAt,
    riskLevel: whoMedicalProductAlertRiskLevel({ title, tag }),
    evidenceType: "public_regulatory_safety_communication",
    metrics: {
      source: "who_medical_product_alerts",
      source_family: "official",
      source_kind: "public_regulatory_safety_communication",
      collection_mode: "who_public_medical_product_alerts_html",
      warning_record_source: "WHO Medical Product Alerts",
      warning_record_type: recordType,
      warning_company: "",
      warning_subject: subject || title,
      warning_issuing_office: "World Health Organization",
      warning_letter_date: publishedAt,
      warning_response_letter: "",
      warning_closeout_letter: "",
      warning_record_id: recordId,
      warning_product: subject,
      warning_tag: tag,
      warning_summary: title,
      source_weight_tier: "global-public-health-alert",
    },
  };
}

function parseWhoMedicalProductAlertResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const blockRegex = /<div\b[^>]*class=["'][^"']*\bvertical-list-item\b[^"']*["'][^>]*>[\s\S]*?<\/a>\s*<\/div>/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const item = normalizeWhoMedicalProductAlertBlock(match[0], keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `who-medical-product-alert:${item.metrics.warning_record_id || item.url || item.title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function emaWhatsNewRecordType(contentType = "", title = "") {
  const text = `${contentType} ${title}`.toLowerCase();
  if (/psusa|periodic safety update/i.test(text)) return "ema-psusa";
  if (/pharmacovigilance|prac|safety signal|signals adopted/i.test(text)) return "ema-pharmacovigilance";
  if (/shortage/.test(text)) return "ema-shortage";
  if (/referral/.test(text)) return "ema-referral";
  if (/medicine/.test(contentType.toLowerCase())) return "ema-medicine-update";
  if (/document/.test(contentType.toLowerCase())) return "ema-document";
  if (/news/.test(contentType.toLowerCase())) return "ema-news";
  return "ema-whats-new";
}

function normalizeEmaWhatsNewRow(cells = [], keyword = "") {
  if (!Array.isArray(cells) || cells.length < 2) return null;
  const publishedDate = cleanText(cells[0], 80);
  const titleCell = String(cells[1] || "");
  const contentType = cleanText((titleCell.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i) || [])[1] || "", 120);
  const linkMatch = titleCell.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const url = absoluteEmaUrl(linkMatch?.[1] || "");
  const title = cleanText(linkMatch?.[2] || titleCell, 620);
  const metadata = cleanText((titleCell.match(/<span\b[^>]*class=["'][^"']*\bmetadata\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "", 520);
  const recordType = emaWhatsNewRecordType(contentType, title);
  const searchable = [publishedDate, contentType, title, metadata, recordType, url].join(" ");
  if (!title || !url || !textMatchesKeyword(searchable, keyword)) return null;
  const publishedAt = normalizeDmySlashDate(publishedDate) || new Date().toISOString();
  return {
    url,
    title: `EMA update: ${title}`,
    content: [
      publishedDate ? `Publication date: ${publishedDate}.` : "",
      contentType ? `Content type: ${contentType}.` : "",
      metadata ? `Substance/metadata: ${metadata}.` : "",
      `Title: ${title}.`,
    ].filter(Boolean).join(" "),
    author: "European Medicines Agency",
    publishedAt,
    riskLevel: emaWhatsNewRiskLevel({ title, contentType, metadata }),
    evidenceType: "public_regulatory_safety_communication",
    metrics: {
      source: "ema_whats_new",
      source_family: "official",
      source_kind: "public_regulatory_safety_communication",
      collection_mode: "ema_public_whats_new_html",
      warning_record_source: "EMA What's New",
      warning_record_type: recordType,
      warning_company: "",
      warning_subject: title,
      warning_issuing_office: "European Medicines Agency",
      warning_letter_date: publishedAt,
      warning_response_letter: "",
      warning_closeout_letter: "",
      warning_content_type: contentType,
      warning_product: title,
      warning_substance: metadata,
      warning_summary: title,
      source_weight_tier: "regulatory-safety-communication",
    },
  };
}

function parseEmaWhatsNewResults(html = "", keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRegex.exec(source)) !== null) {
    const item = normalizeEmaWhatsNewRow(extractCells(match[1]), keyword);
    if (!item || !isAfterSince(item.publishedAt, since)) continue;
    const dedupeKey = `ema-whats-new:${item.url || `${item.title}:${item.publishedAt}`}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(item);
    if (out.length >= Math.max(1, Math.min(40, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertWarningLetterItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = warningLetterDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "public_regulatory_warning_letter_sources",
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
      source_key: "publicRegulatoryWarningLetterSources",
      evidence: {
        evidence_type: item.evidenceType || "public_regulatory_warning_letter",
        metrics: {
          ...(item.metrics || {}),
          ...warningLetterRiskSignals(item),
          ...warningLetterKeywordDiagnostics(item, keyword),
          warning_letter_canonical_dedupe_key: dedupeKey,
          warning_letter_search_scan_dedupe_key: dedupeKey,
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

export async function scrapePublicRegulatoryWarningLetterSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = DEFAULT_WARNING_LETTER_TARGETS, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
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
        const isHsaTarget = target.kind === "hsa_announcements_html" || target.key === "hsa_announcements";
        const isWhoTarget = target.kind === "who_medical_product_alerts_html" || target.key === "who_medical_product_alerts";
        const isEmaTarget = target.kind === "ema_whats_new_html" || target.key === "ema_whats_new";
        const url = target.kind === "fda_warning_letters_html" || target.key === "fda_warning_letters"
          ? fdaWarningLettersSearchUrl(keyword)
        : target.kind === "fda_drug_safety_communications_html" || target.key === "fda_drug_safety_communications"
          ? fdaDrugSafetyCommunicationsSearchUrl(keyword)
        : target.kind === "uk_drug_device_alerts_atom" || target.key === "uk_drug_device_alerts"
          ? ukDrugDeviceAlertsUrl()
        : target.kind === "pmda_post_marketing_safety_rss" || target.key === "pmda_post_marketing_safety"
          ? target.url
        : target.kind === "cdsco_alerts_html" || target.key === "cdsco_alerts"
          ? target.url
        : isHsaTarget
          ? target.url
        : isWhoTarget
          ? target.url
        : isEmaTarget
          ? target.url
          : target.url;
        const requestUrls = isEmaTarget ? emaWhatsNewUrls(url) : [url];
        for (const requestUrl of requestUrls) {
          const res = await fetchPublicSource(requestUrl, {
            headers: {
              "User-Agent": isHsaTarget ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" : USER_AGENT,
              "Accept": target.kind === "uk_drug_device_alerts_atom" || target.key === "uk_drug_device_alerts" || target.kind === "pmda_post_marketing_safety_rss" || target.key === "pmda_post_marketing_safety" ? "application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain,*/*" : "text/html,application/xhtml+xml,*/*",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
            continue;
          }
          const html = await res.text();
          const items = target.kind === "fda_drug_safety_communications_html" || target.key === "fda_drug_safety_communications"
            ? parseFdaDrugSafetyCommunicationResults(html, keyword, {
              limit: normalizedBudget.maxItemsPerKeyword,
              since,
            })
            : target.kind === "uk_drug_device_alerts_atom" || target.key === "uk_drug_device_alerts"
              ? parseUkDrugDeviceAlertResults(html, keyword, {
                limit: normalizedBudget.maxItemsPerKeyword,
                since,
              })
            : target.kind === "pmda_post_marketing_safety_rss" || target.key === "pmda_post_marketing_safety"
              ? parsePmdaSafetyMeasureResults(html, keyword, {
                limit: normalizedBudget.maxItemsPerKeyword,
                since,
              })
            : target.kind === "cdsco_alerts_html" || target.key === "cdsco_alerts"
              ? parseCdscoAlertResults(html, keyword, {
                limit: normalizedBudget.maxItemsPerKeyword,
                since,
              })
            : isHsaTarget
              ? parseHsaAnnouncementResults(html, keyword, {
                limit: normalizedBudget.maxItemsPerKeyword,
                since,
              })
            : isWhoTarget
              ? parseWhoMedicalProductAlertResults(html, keyword, {
                limit: normalizedBudget.maxItemsPerKeyword,
                since,
              })
            : isEmaTarget
              ? parseEmaWhatsNewResults(html, keyword, {
                limit: normalizedBudget.maxItemsPerKeyword,
                since,
              })
            : parseFdaWarningLetterResults(html, keyword, {
              limit: normalizedBudget.maxItemsPerKeyword,
              since,
            });
          inserted += await insertWarningLetterItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target?.key || "public-regulatory-warning-letters", message });
      console.warn(`[CRM/PublicRegulatoryWarningLetters] 抓取失敗 target=${target?.key || "unknown"} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  FDA_WARNING_LETTERS_URL,
  FDA_DRUG_SAFETY_COMMUNICATIONS_URL,
  UK_DRUG_DEVICE_ALERTS_ATOM_URL,
  PMDA_POST_MARKETING_SAFETY_RSS_URL,
  CDSCO_ALERTS_URL,
  HSA_ANNOUNCEMENTS_URL,
  WHO_MEDICAL_PRODUCT_ALERTS_URL,
  EMA_WHATS_NEW_URL,
  DEFAULT_WARNING_LETTER_TARGETS,
  normalizeBudget,
  normalizeTargets,
  normalizeWarningLetterKeywordText,
  textMatchesKeyword,
  fdaWarningLettersSearchUrl,
  fdaDrugSafetyCommunicationsSearchUrl,
  ukDrugDeviceAlertsUrl,
  normalizeWarningLetterDedupeUrl,
  warningLetterDedupeKey,
  warningLetterKeywordMatchSource,
  warningLetterKeywordDiagnostics,
  warningLetterRiskSignals,
  regulatoryWarningLetterRiskLevel,
  drugSafetyCommunicationRiskLevel,
  cdscoAlertRiskLevel,
  hsaAnnouncementRiskLevel,
  whoMedicalProductAlertRiskLevel,
  emaWhatsNewRiskLevel,
  emaWhatsNewUrls,
  atomItems,
  rss1Items,
  parseFdaWarningLetterResults,
  parseFdaDrugSafetyCommunicationResults,
  parseUkDrugDeviceAlertResults,
  parsePmdaSafetyMeasureResults,
  parseCdscoAlertResults,
  parseHsaAnnouncementResults,
  parseWhoMedicalProductAlertResults,
  parseEmaWhatsNewResults,
};
