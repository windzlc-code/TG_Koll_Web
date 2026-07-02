/**
 * scrapers/public-company-filings-sources.js — public company filing discovery
 *
 * Uses no-key SEC EDGAR and UK Gazette public JSON endpoints to collect
 * high-trust official disclosure and company-risk notice signals.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0; public-opinion-monitor)";
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_COMPANIES_PER_KEYWORD = 4;
const DEFAULT_MAX_GAZETTE_QUERIES_PER_KEYWORD = 4;
const DEFAULT_MAX_GAZETTE_PAGES_PER_QUERY = 3;
const SEC_COMPANY_TICKERS_EXCHANGE_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const THE_GAZETTE_NOTICE_JSON_URL = "https://www.thegazette.co.uk/all-notices/notice/data.json";
const GAZETTE_COMPANY_RISK_TERMS = [
  "insolvency",
  "liquidation",
  "winding up",
  "administration",
  "strike off",
  "dissolution",
  "receivership",
  "creditors",
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
  const maxCompanies = Math.round(Number(budget.maxCompaniesPerKeyword || budget.max_companies_per_keyword || DEFAULT_MAX_COMPANIES_PER_KEYWORD));
  const maxGazetteQueries = Math.round(Number(budget.maxGazetteQueriesPerKeyword || budget.max_gazette_queries_per_keyword || DEFAULT_MAX_GAZETTE_QUERIES_PER_KEYWORD));
  const maxGazettePages = Math.round(Number(budget.maxGazettePagesPerQuery || budget.max_gazette_pages_per_query || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_GAZETTE_PAGES_PER_QUERY));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxCompaniesPerKeyword: Number.isFinite(maxCompanies) ? Math.max(1, Math.min(12, maxCompanies)) : DEFAULT_MAX_COMPANIES_PER_KEYWORD,
    maxGazetteQueriesPerKeyword: Number.isFinite(maxGazetteQueries) ? Math.max(1, Math.min(8, maxGazetteQueries)) : DEFAULT_MAX_GAZETTE_QUERIES_PER_KEYWORD,
    maxGazettePagesPerQuery: Number.isFinite(maxGazettePages) ? Math.max(1, Math.min(3, maxGazettePages)) : DEFAULT_MAX_GAZETTE_PAGES_PER_QUERY,
  };
}

function normalizeDate(value = "") {
  const raw = String(value || "").trim();
  if (/^\d{8}$/.test(raw)) {
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`;
    const time = new Date(formatted).getTime();
    return Number.isNaN(time) ? "" : new Date(time).toISOString();
  }
  if (/^\d{14}$/.test(raw)) {
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}.000Z`;
    const time = new Date(formatted).getTime();
    return Number.isNaN(time) ? "" : new Date(time).toISOString();
  }
  const time = new Date(raw || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeCompanyFilingKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeCompanyFilingKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeCompanyFilingKeywordText(text);
  return keywordNeedles(keyword).some(needle => {
    const normalizedNeedle = normalizeCompanyFilingKeywordText(needle);
    if (needle.length < 2) return false;
    return lower.includes(needle) || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle));
  });
}

function normalizeCik(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? digits.padStart(10, "0").slice(-10) : "";
}

function secSubmissionsUrl(cik) {
  return `https://data.sec.gov/submissions/CIK${normalizeCik(cik)}.json`;
}

function secFilingUrl({ cik, accessionNumber, primaryDocument }) {
  const normalizedCik = String(Number(String(cik || "").replace(/\D/g, "")) || "").trim();
  const accessionNoDashes = String(accessionNumber || "").replace(/-/g, "");
  const document = cleanText(primaryDocument, 260);
  if (!normalizedCik || !accessionNoDashes || !document) return "https://www.sec.gov/edgar/search/";
  return `https://www.sec.gov/Archives/edgar/data/${normalizedCik}/${accessionNoDashes}/${encodeURIComponent(document)}`;
}

function normalizeCompanyFilingDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeCompanyFilingDedupeUrl(embedded);
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

function companyFilingDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const source = cleanText(metrics.source || metrics.notice_record_source || "company-filing", 140).toLowerCase();
  const cik = normalizeCik(metrics.cik || "");
  const accessionNumber = cleanText(metrics.accession_number || "", 120);
  if (cik && accessionNumber) return `sec:${cik}:${accessionNumber}`.toLowerCase();
  const noticeUrl = normalizeCompanyFilingDedupeUrl(item.url || "");
  if (noticeUrl && /thegazette\.co\.uk\/notice\//i.test(noticeUrl)) return `gazette:${noticeUrl}`.toLowerCase();
  const urlKey = normalizeCompanyFilingDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  return [
    source,
    cleanText(metrics.notice_title || item.title || "", 260),
    cleanText(metrics.notice_published_at || item.publishedAt || "", 80),
  ].filter(Boolean).join(":").toLowerCase();
}

function companyFilingKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["company_name", metrics.company_name],
    ["ticker", metrics.ticker],
    ["exchange", metrics.exchange],
    ["cik", metrics.cik],
    ["form", metrics.form],
    ["items", metrics.items],
    ["primary_doc_description", metrics.primary_doc_description],
    ["sec_filing_document_excerpt", metrics.sec_filing_document_excerpt],
    ["notice_record_source", metrics.notice_record_source],
    ["notice_title", metrics.notice_title],
    ["notice_query", metrics.notice_query],
    ["notice_category", metrics.notice_category],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword(value || "", keyword));
  return match ? match[0] : "";
}

function companyFilingKeywordDiagnostics(item = {}, keyword = "") {
  return {
    company_filing_matched_keyword: cleanText(keyword, 160),
    company_filing_keyword_match_source: companyFilingKeywordMatchSource(item, keyword),
  };
}

function companyFilingRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const riskTerms = Array.isArray(metrics.sec_filing_document_risk_terms)
    ? metrics.sec_filing_document_risk_terms.join(" ")
    : String(metrics.sec_filing_document_risk_terms || "");
  const text = cleanText([
    item.title,
    item.content,
    item.author,
    item.evidenceType,
    metrics.source,
    metrics.source_family,
    metrics.source_kind,
    metrics.company_name,
    metrics.ticker,
    metrics.exchange,
    metrics.form,
    metrics.items,
    metrics.accession_number,
    metrics.filing_date,
    metrics.report_date,
    metrics.acceptance_datetime,
    metrics.primary_doc_description,
    metrics.sec_filing_document_excerpt,
    riskTerms,
    metrics.notice_record_source,
    metrics.notice_title,
    metrics.notice_category,
    metrics.notice_query,
    metrics.source_weight_tier,
  ].filter(Boolean).join(" "), 9000).toLowerCase();
  const reasons = [];
  let score = /public-company-filing|official-company-notice|finance|official/i.test(String(metrics.source_weight_tier || metrics.source_family || "")) ? 14 : 8;
  const out = {};
  const termMatches = (terms = []) => {
    const source = normalizeCompanyFilingKeywordText(text);
    return terms.filter(term => {
      const needle = normalizeCompanyFilingKeywordText(term);
      return needle && source.includes(needle);
    });
  };
  const evidenceTerms = termMatches([
    "accession number", "filing date", "report date", "acceptance date", "form 8-k", "item 1.05", "item 8.01", "exhibit", "primary document", "document excerpt",
    "公告編號", "公告编号", "申報日期", "申报日期", "報告日期", "报告日期", "表格8-k", "項目1.05", "项目1.05", "附件", "主要文件", "文件摘錄", "文件摘录",
  ]);
  const timelineTerms = termMatches([
    "filed", "reported", "identified", "discovered", "announced", "accepted", "effective", "dated", "as of", "within four business days",
    "提交", "申報", "申报", "報告", "报告", "發現", "发现", "識別", "识别", "公告", "生效", "截至", "四個工作日", "四个工作日",
  ]);
  const financialImpactTerms = termMatches([
    "material impact", "material adverse", "business interruption", "revenue", "liquidity", "cash flow", "impairment", "loss", "expense", "cost", "substantial doubt",
    "重大影響", "重大影响", "重大不利", "業務中斷", "业务中断", "收入", "流動性", "流动性", "現金流", "现金流", "減值", "减值", "損失", "损失", "費用", "费用",
  ]);
  const responseTerms = termMatches([
    "management response", "board", "audit committee", "remediation", "corrective action", "incident response", "engaged counsel", "notified regulators", "cooperating with", "insurance",
    "管理層回應", "管理层回应", "董事會", "董事会", "審計委員會", "审计委员会", "整改", "改善措施", "事件響應", "事件响应", "聘請律師", "聘请律师", "通知監管", "通知监管", "配合調查", "配合调查", "保險", "保险",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("company_filing_public_company_signal", "public company filing or official company notice", /sec|edgar|filing|form|gazette|company notice|public-company-filing|official-company-notice|上市|公告|公司公告/i.test(text), 6);
  addSignal("company_filing_material_event_signal", "material event or Form 8-K style disclosure", /\b8-k\b|material event|item\s+1\.05|item\s+2\.0[1-6]|item\s+4\.0[12]|item\s+8\.01|重大事件|重大事項|重大事项/i.test(text), 10);
  addSignal("company_filing_cybersecurity_signal", "cybersecurity incident, ransomware, or unauthorized access", /cybersecurity|data breach|unauthorized access|ransomware|business interruption|customer data|網絡安全|网络安全|資料外洩|数据泄露|未授權|未授权|勒索/i.test(text), 18);
  addSignal("company_filing_financial_distress_signal", "bankruptcy, liquidation, winding-up, or insolvency", /bankruptcy|chapter 11|liquidation|winding[-\s]?up|administration|receivership|insolven|creditors|strike[-\s]?off|dissolution|bankrupt|破產|破产|清算|資不抵債|资不抵债|債權人|债权人/i.test(text), 18);
  addSignal("company_filing_going_concern_signal", "going concern or substantial doubt disclosure", /going concern|substantial doubt|ability to continue|持續經營|持续经营/i.test(text), 14);
  addSignal("company_filing_restatement_signal", "restatement, non-reliance, or material weakness", /restatement|non-reliance|material weakness|internal control|audit|重述|不可依賴|不可依赖|重大缺陷|內控|内控/i.test(text), 14);
  addSignal("company_filing_delisting_signal", "delisting or exchange compliance concern", /delisting|notice of noncompliance|listing standards|exchange compliance|nasdaq listing|nyse listing|退市|摘牌|上市規則|上市规则/i.test(text), 12);
  addSignal("company_filing_litigation_regulatory_signal", "litigation, investigation, subpoena, or regulatory proceeding", /lawsuit|litigation|investigation|subpoena|regulatory proceeding|enforcement|fraud|訴訟|诉讼|調查|调查|傳票|传票|監管程序|监管程序|欺詐|欺诈/i.test(text), 14);
  addSignal("company_filing_product_safety_signal", "product recall or safety issue disclosure", /product recall|safety issue|recall|defect|injury|產品召回|产品召回|安全問題|安全问题|缺陷/i.test(text), 10);
  addSignal("company_filing_gazette_notice_signal", "Gazette company-risk notice", /gazette|winding-up|liquidation|administration|official-company-notice|the gazette/i.test(text), 10);
  addSignal("company_filing_evidence_language_signal", "accession, filing/report date, item, exhibit, or document evidence language", evidenceTerms.length > 0, 10);
  addSignal("company_filing_timeline_language_signal", "filed, reported, discovered, announced, accepted, or effective timeline language", timelineTerms.length > 0, 8);
  addSignal("company_filing_financial_impact_signal", "material impact, business interruption, revenue, liquidity, loss, or cost language", financialImpactTerms.length > 0, 12);
  addSignal("company_filing_response_language_signal", "management, board, remediation, counsel, regulator, or insurance response language", responseTerms.length > 0, 10);

  const semanticSignals = [
    out.company_filing_public_company_signal,
    out.company_filing_material_event_signal,
    out.company_filing_cybersecurity_signal,
    out.company_filing_financial_distress_signal,
    out.company_filing_going_concern_signal,
    out.company_filing_restatement_signal,
    out.company_filing_delisting_signal,
    out.company_filing_litigation_regulatory_signal,
    out.company_filing_product_safety_signal,
    out.company_filing_gazette_notice_signal,
    out.company_filing_evidence_language_signal,
    out.company_filing_timeline_language_signal,
    out.company_filing_financial_impact_signal,
    out.company_filing_response_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "company_filing_complete_material_event_narrative_signal",
    "complete company material event narrative",
    semanticSignals >= 5
      && out.company_filing_public_company_signal
      && (out.company_filing_material_event_signal || out.company_filing_financial_distress_signal || out.company_filing_gazette_notice_signal)
      && (out.company_filing_cybersecurity_signal || out.company_filing_litigation_regulatory_signal || out.company_filing_product_safety_signal || out.company_filing_financial_distress_signal || out.company_filing_restatement_signal)
      && (out.company_filing_evidence_language_signal || out.company_filing_timeline_language_signal)
      && (out.company_filing_financial_impact_signal || out.company_filing_response_language_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    company_filing_risk_score: boundedScore,
    company_filing_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    company_filing_signal_count: signalFields.length,
    company_filing_semantic_signal_count: semanticSignals,
    company_filing_signal_reasons: [...new Set(reasons)].slice(0, 12),
    company_filing_evidence_terms: evidenceTerms,
    company_filing_timeline_terms: timelineTerms,
    company_filing_financial_impact_terms: financialImpactTerms,
    company_filing_response_terms: responseTerms,
  };
}

function normalizeCompanyRow(row = {}, fields = []) {
  if (Array.isArray(row)) {
    const fieldIndex = name => fields.findIndex(field => String(field || "").toLowerCase() === name);
    return {
      cik: normalizeCik(row[fieldIndex("cik")] ?? row[fieldIndex("cik_str")] ?? row[0]),
      name: cleanText(row[fieldIndex("name")] ?? row[fieldIndex("title")] ?? row[1], 260),
      ticker: cleanText(row[fieldIndex("ticker")] ?? row[2], 40).toUpperCase(),
      exchange: cleanText(row[fieldIndex("exchange")] ?? row[3], 80),
    };
  }
  return {
    cik: normalizeCik(row.cik || row.cik_str),
    name: cleanText(row.name || row.title, 260),
    ticker: cleanText(row.ticker, 40).toUpperCase(),
    exchange: cleanText(row.exchange, 80),
  };
}

function parseSecCompanyTickers(payload = {}, keyword = "", { limit = DEFAULT_MAX_COMPANIES_PER_KEYWORD } = {}) {
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Object.keys(payload || {})
      .filter(key => /^\d+$/.test(key))
      .map(key => payload[key]);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const company = normalizeCompanyRow(row, fields);
    if (!company.cik || !company.name) continue;
    const searchable = `${company.name} ${company.ticker} ${company.exchange}`;
    if (!textMatchesKeyword(searchable, keyword)) continue;
    const dedupeKey = `${company.cik}:${company.ticker}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(company);
    if (out.length >= Math.max(1, Math.min(12, Number(limit) || DEFAULT_MAX_COMPANIES_PER_KEYWORD))) break;
  }
  return out;
}

function filingRiskLevel({ form = "", description = "", items = "" } = {}) {
  const text = `${form} ${description} ${items}`.toLowerCase();
  if (/1\.05|cybersecurity|data breach|breach|bankruptcy|chapter 11|restatement|non-reliance|delisting|investigation|lawsuit|litigation|fraud|material weakness|going concern/i.test(text)) return "high";
  if (/8-k|10-k|10-q|20-f|6-k|s-1|def 14a|sc 13d|annual|quarterly|material event|risk factor/i.test(text)) return "medium";
  return "low";
}

function secFilingDocumentRiskTerms(text = "") {
  const source = cleanText(text, 6000).toLowerCase();
  const terms = [
    "cybersecurity incident",
    "material cybersecurity",
    "data breach",
    "unauthorized access",
    "ransomware",
    "business interruption",
    "material weakness",
    "going concern",
    "substantial doubt",
    "restatement",
    "non-reliance",
    "delisting",
    "bankruptcy",
    "chapter 11",
    "investigation",
    "subpoena",
    "lawsuit",
    "litigation",
    "fraud",
    "regulatory proceeding",
    "product recall",
    "safety issue",
  ];
  return terms.filter(term => source.includes(term));
}

function parseSecFilingDocumentDetails(html = "", keyword = "") {
  const text = cleanText(html, 12000);
  if (!text) return {};
  const itemNumbers = [...new Set([...text.matchAll(/\bItem\s+(\d{1,2}\.\d{2})\b/gi)].map(match => match[1]))].slice(0, 12);
  const riskTerms = secFilingDocumentRiskTerms(text);
  const lower = text.toLowerCase();
  const compact = normalizeCompanyFilingKeywordText(text);
  const keywordNeedle = keywordNeedles(keyword).find((needle) => {
    const normalizedNeedle = normalizeCompanyFilingKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
  const riskNeedle = riskTerms.find(term => lower.includes(term));
  const needle = keywordNeedle || riskNeedle || itemNumbers[0] ? `Item ${itemNumbers[0]}` : "";
  let excerpt = text.slice(0, 900);
  if (needle) {
    const index = lower.indexOf(String(needle).toLowerCase());
    if (index >= 0) excerpt = text.slice(Math.max(0, index - 220), index + 900);
  }
  return {
    text_length: text.length,
    item_numbers: itemNumbers,
    risk_terms: riskTerms,
    keyword_hit: Boolean(keywordNeedle),
    excerpt: cleanText(excerpt, 1200),
  };
}

function shouldFetchSecFilingDocument(item = {}) {
  const metrics = item.metrics || {};
  if (metrics.source !== "sec_edgar_submissions") return false;
  if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//i.test(String(item.url || ""))) return false;
  const form = cleanText(metrics.form || "", 40).toUpperCase();
  if (item.riskLevel === "high") return true;
  return /^(8-K|10-K|10-Q|20-F|6-K|S-1|DEF 14A|SC 13D)$/.test(form);
}

function mergeSecFilingDocumentDetails(item = {}, detail = {}) {
  if (!item || !detail || !detail.excerpt) return item;
  const metrics = {
    ...(item.metrics || {}),
    collection_mode: "sec_public_submissions_json_with_primary_document",
    sec_filing_document_fetched: true,
    sec_filing_document_text_length: detail.text_length || 0,
    sec_filing_item_numbers: detail.item_numbers || [],
    sec_filing_document_risk_terms: detail.risk_terms || [],
    sec_filing_document_keyword_hit: Boolean(detail.keyword_hit),
    sec_filing_document_excerpt: detail.excerpt || "",
  };
  const riskLevel = (detail.risk_terms || []).length ? "high" : item.riskLevel;
  return {
    ...item,
    content: [
      item.content,
      detail.item_numbers?.length ? `Primary document item(s): ${detail.item_numbers.join(", ")}.` : "",
      detail.risk_terms?.length ? `Primary document risk terms: ${detail.risk_terms.join(", ")}.` : "",
      detail.excerpt ? `Primary document excerpt: ${detail.excerpt}` : "",
    ].filter(Boolean).join(" "),
    riskLevel,
    metrics,
  };
}

function gazetteNoticeSearchUrl(query = "", page = 1) {
  const url = new URL(THE_GAZETTE_NOTICE_JSON_URL);
  url.searchParams.set("text", cleanText(query, 180));
  url.searchParams.set("results-page", String(Math.max(1, Number(page) || 1)));
  return url.toString();
}

function absoluteGazetteUrl(value = "") {
  const raw = cleanText(value, 500);
  if (!raw) return "https://www.thegazette.co.uk/all-notices/notice";
  if (/^https?:\/\//i.test(raw)) return raw.replace("https://elb.api.gaz.ette:8080", "https://www.thegazette.co.uk");
  if (raw.startsWith("/")) return `https://www.thegazette.co.uk${raw}`;
  return `https://www.thegazette.co.uk/${raw.replace(/^\/+/, "")}`;
}

function gazetteEntryUrl(entry = {}) {
  if (entry.id) return absoluteGazetteUrl(entry.id);
  const links = Array.isArray(entry.link) ? entry.link : [entry.link].filter(Boolean);
  const href = links.find(link => link?.["@href"] && !/data\.pdf/i.test(link["@href"]))?.["@href"]
    || links.find(link => link?.["@href"])?.["@href"];
  return absoluteGazetteUrl(href);
}

function gazetteRiskCategory(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/winding[-\s]?up|wind up/.test(lower)) return "winding-up";
  if (/liquidation|liquidator|voluntary arrangement/.test(lower)) return "liquidation";
  if (/administration|administrator/.test(lower)) return "administration";
  if (/strike[-\s]?off|struck off|dissolution|dissolved/.test(lower)) return "strike-off-or-dissolution";
  if (/receivership|receiver/.test(lower)) return "receivership";
  if (/creditors|debt|insolven/.test(lower)) return "creditor-or-insolvency";
  return "company-risk-notice";
}

function gazetteRiskLevel({ category = "", text = "" } = {}) {
  const combined = `${category} ${text}`.toLowerCase();
  if (/winding-up|liquidation|administration|receivership|insolven|creditors|strike-off|dissolution|dissolved|fraud|bankrupt/i.test(combined)) return "high";
  return "medium";
}

function countGazetteCompanyNoticeRawResults(payload = {}) {
  return Array.isArray(payload?.entry) ? payload.entry.length : 0;
}

function parseGazetteCompanyNoticeResults(payload = {}, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "", sourceQuery = "", page = 1, rawResultCount = 0 } = {}) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const title = cleanText(entry.title, 300);
    const content = cleanText(entry.content, 1800);
    const publishedAt = normalizeDate(entry.published || entry.updated || payload.updated) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const searchable = `${title} ${content}`;
    if (!textMatchesKeyword(searchable, keyword)) continue;
    if (!GAZETTE_COMPANY_RISK_TERMS.some(term => textMatchesKeyword(searchable, term))) continue;
    const url = gazetteEntryUrl(entry);
    const dedupeKey = `${url}:${publishedAt}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const category = gazetteRiskCategory(searchable);
    const author = cleanText(entry.author?.name || "The Gazette", 120);
    out.push({
      url,
      title: `The Gazette company notice: ${title}`,
      content: [
        content,
        sourceQuery ? `Matched Gazette query: ${sourceQuery}.` : "",
        category ? `Company notice category: ${category}.` : "",
      ].filter(Boolean).join(" "),
      author,
      publishedAt,
      riskLevel: gazetteRiskLevel({ category, text: searchable }),
      evidenceType: "public_company_notice",
      metrics: {
        source: "the_gazette_company_notices",
        source_family: "official",
        source_kind: "public_company_notice",
        collection_mode: "the_gazette_public_notice_json",
        notice_record_source: "The Gazette",
        notice_category: category,
        notice_title: title,
        notice_query: cleanText(sourceQuery, 180),
        notice_search_page: Math.max(1, Number(page) || 1),
        notice_search_raw_result_count: Math.max(0, Number(rawResultCount) || 0),
        notice_published_at: publishedAt,
        source_weight_tier: "official-company-notice",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function recentValue(recent = {}, key, index) {
  const values = recent?.[key];
  return Array.isArray(values) ? values[index] : "";
}

function parseSecSubmissions(payload = {}, keyword = "", { company = {}, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const recent = payload?.filings?.recent || {};
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const out = [];
  const seen = new Set();
  const companyName = cleanText(payload.name || company.name, 260);
  const cik = normalizeCik(payload.cik || company.cik);
  const tickers = Array.isArray(payload.tickers) ? payload.tickers : [company.ticker].filter(Boolean);
  const exchanges = Array.isArray(payload.exchanges) ? payload.exchanges : [company.exchange].filter(Boolean);
  const relevanceGate = `${companyName} ${tickers.join(" ")} ${exchanges.join(" ")}`;
  if (!textMatchesKeyword(relevanceGate, keyword)) return out;
  for (let index = 0; index < forms.length; index += 1) {
    const form = cleanText(forms[index], 40);
    const accessionNumber = cleanText(recentValue(recent, "accessionNumber", index), 80);
    const filingDate = cleanText(recentValue(recent, "filingDate", index), 40);
    const reportDate = cleanText(recentValue(recent, "reportDate", index), 40);
    const acceptanceDateTime = cleanText(recentValue(recent, "acceptanceDateTime", index), 40);
    const primaryDocument = cleanText(recentValue(recent, "primaryDocument", index), 260);
    const description = cleanText(recentValue(recent, "primaryDocDescription", index), 500);
    const items = cleanText(recentValue(recent, "items", index), 220);
    const publishedAt = normalizeDate(filingDate || acceptanceDateTime || reportDate) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const dedupeKey = `${cik}:${accessionNumber || form}:${filingDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const title = `SEC filing: ${companyName} ${form}${filingDate ? ` ${filingDate}` : ""}`;
    const content = [
      `${companyName} filed ${form || "a filing"} with the U.S. SEC EDGAR system.`,
      description ? `Description: ${description}.` : "",
      items ? `Items: ${items}.` : "",
      reportDate ? `Report date: ${reportDate}.` : "",
      tickers.length ? `Ticker: ${tickers.join(", ")}.` : "",
      exchanges.length ? `Exchange: ${exchanges.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
    out.push({
      url: secFilingUrl({ cik, accessionNumber, primaryDocument }),
      title,
      content,
      author: "U.S. SEC EDGAR",
      publishedAt,
      riskLevel: filingRiskLevel({ form, description, items }),
      metrics: {
        source: "sec_edgar_submissions",
        source_family: "finance",
        source_kind: "public_company_filing",
        collection_mode: "sec_public_submissions_json",
        company_name: companyName,
        ticker: tickers[0] || company.ticker || "",
        exchange: exchanges[0] || company.exchange || "",
        cik,
        form,
        accession_number: accessionNumber,
        filing_date: filingDate,
        report_date: reportDate,
        acceptance_datetime: acceptanceDateTime,
        items,
        primary_document: primaryDocument,
        primary_doc_description: description,
        source_weight_tier: "public-company-filing",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertFilingItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = companyFilingDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "public_company_filings_sources",
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
      source_key: "publicCompanyFilingsSources",
      evidence: {
        evidence_type: item.evidenceType || "public_company_filing",
        metrics: {
          ...(item.metrics || {}),
          ...companyFilingRiskSignals(item),
          ...companyFilingKeywordDiagnostics(item, keyword),
          company_filing_canonical_dedupe_key: dedupeKey,
          company_filing_search_scan_dedupe_key: dedupeKey,
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

export async function scrapePublicCompanyFilingsSources(keywords, { proxyUrl = "", budget = {}, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const indexRes = await fetchPublicSource(SEC_COMPANY_TICKERS_EXCHANGE_URL, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/plain,*/*",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!indexRes.ok) {
        failures.push({ keyword, target: "sec-company-tickers-exchange", message: httpFailure(indexRes) });
        return { inserted, failures };
      }
      const companies = parseSecCompanyTickers(await indexRes.json(), keyword, {
        limit: normalizedBudget.maxCompaniesPerKeyword,
      });
      for (const company of companies) {
        const submissionsUrl = secSubmissionsUrl(company.cik);
        try {
          const submissionsRes = await fetchPublicSource(submissionsUrl, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "application/json,text/plain,*/*",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!submissionsRes.ok) {
            failures.push({ keyword, target: `sec-submissions-${company.cik}`, message: httpFailure(submissionsRes) });
            continue;
          }
          const items = parseSecSubmissions(await submissionsRes.json(), keyword, {
            company,
            limit: normalizedBudget.maxItemsPerKeyword,
            since,
          });
          const enrichedItems = await mapWithConcurrency(items, SEARCH_CONCURRENCY, async (item) => {
            if (!shouldFetchSecFilingDocument(item)) return item;
            try {
              const detailRes = await fetchPublicSource(item.url, {
                headers: {
                  "User-Agent": USER_AGENT,
                  "Accept": "text/html,text/plain,*/*",
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              }, proxyUrl);
              if (!detailRes.ok) return item;
              return mergeSecFilingDocumentDetails(item, parseSecFilingDocumentDetails(await detailRes.text(), keyword));
            } catch {
              return item;
            }
          });
          inserted += await insertFilingItems(enrichedItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
        } catch (err) {
          const message = formatSourceError(err, proxyUrl);
          failures.push({ keyword, target: `sec-submissions-${company.cik}`, message });
          console.warn(`[CRM/PublicCompanyFilings] 抓取公司披露失敗 keyword=${keyword} cik=${company.cik}: ${message}`);
        }
      }
      const gazetteQueries = GAZETTE_COMPANY_RISK_TERMS
        .slice(0, normalizedBudget.maxGazetteQueriesPerKeyword)
        .map(term => `${keyword} ${term}`);
      for (const query of gazetteQueries) {
        for (let page = 1; page <= normalizedBudget.maxGazettePagesPerQuery; page += 1) {
          const gazetteUrl = gazetteNoticeSearchUrl(query, page);
          try {
            const gazetteRes = await fetchPublicSource(gazetteUrl, {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept": "application/json,text/plain,*/*",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!gazetteRes.ok) {
              failures.push({ keyword, target: "the-gazette-company-notices", message: httpFailure(gazetteRes) });
              continue;
            }
            const payload = await gazetteRes.json();
            const rawResultCount = countGazetteCompanyNoticeRawResults(payload);
            const items = parseGazetteCompanyNoticeResults(payload, keyword, {
              limit: normalizedBudget.maxItemsPerKeyword,
              since,
              sourceQuery: query,
              page,
              rawResultCount,
            });
            inserted += await insertFilingItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
            if (rawResultCount < normalizedBudget.maxItemsPerKeyword) break;
          } catch (err) {
            const message = formatSourceError(err, proxyUrl);
            failures.push({ keyword, target: "the-gazette-company-notices", message });
            console.warn(`[CRM/PublicCompanyFilings] 抓取 Gazette 公司公告失敗 keyword=${keyword}: ${message}`);
          }
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "sec-company-filings", message });
      console.warn(`[CRM/PublicCompanyFilings] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  SEC_COMPANY_TICKERS_EXCHANGE_URL,
  THE_GAZETTE_NOTICE_JSON_URL,
  GAZETTE_COMPANY_RISK_TERMS,
  normalizeBudget,
  normalizeCompanyFilingKeywordText,
  textMatchesKeyword,
  normalizeCik,
  secSubmissionsUrl,
  secFilingUrl,
  normalizeCompanyFilingDedupeUrl,
  companyFilingDedupeKey,
  companyFilingKeywordMatchSource,
  companyFilingKeywordDiagnostics,
  companyFilingRiskSignals,
  gazetteNoticeSearchUrl,
  gazetteRiskCategory,
  gazetteRiskLevel,
  countGazetteCompanyNoticeRawResults,
  filingRiskLevel,
  secFilingDocumentRiskTerms,
  parseSecFilingDocumentDetails,
  shouldFetchSecFilingDocument,
  mergeSecFilingDocumentDetails,
  parseSecCompanyTickers,
  parseSecSubmissions,
  parseGazetteCompanyNoticeResults,
};
