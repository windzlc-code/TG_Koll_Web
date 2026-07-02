/**
 * scrapers/legal-public-records.js — public legal record discovery
 *
 * Uses no-key public sources for legal/crisis evidence:
 * - CourtListener public search API
 * - DuckDuckGo site search over Justia public case/class-action pages
 */

import { isAfterSince, isRecentDate } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 8;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const LEGAL_CONTEXT_TERMS = [
  "lawsuit",
  "litigation",
  "class action",
  "complaint",
  "settlement",
  "court",
  "judge",
  "docket",
  "opinion",
  "appeal",
  "investigation",
  "enforcement",
  "suit",
  "起訴",
  "起诉",
  "訴訟",
  "诉讼",
  "法院",
  "判決",
  "判决",
  "集體訴訟",
  "集体诉讼",
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
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function deepPagesPerKeyword(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") return 0;
  const value = Math.round(Number(deepBudget.maxPagesPerKeyword ?? deepBudget.max_pages_per_keyword ?? 0));
  return Math.max(0, Math.min(3, Number.isFinite(value) ? value : 0));
}

function normalizeUrl(rawUrl = "") {
  const decoded = cleanText(rawUrl, 1000);
  try {
    const url = new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return normalizeUrl(decodeURIComponent(uddg));
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeLegalDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 1000);
  try {
    const url = new URL(raw);
    const embedded = url.searchParams.get("uddg") || url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeLegalDedupeUrl(decodeURIComponent(embedded));
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "fbclid",
      "gclid",
      "ocid",
      "cid",
      "ref",
      "ref_src",
      "source",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function legalRecordDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  const urlKey = normalizeLegalDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  const source = cleanText(metrics.source || metrics.legal_record_source || "legal-public-record", 140).toLowerCase();
  const docketNumber = cleanText(metrics.docket_number || "", 140);
  if (docketNumber) return `${source}:docket:${docketNumber}`.toLowerCase();
  return [
    source,
    cleanText(item.title || "", 260),
    cleanText(item.publishedAt || "", 80),
  ].filter(Boolean).join(":").toLowerCase();
}

function normalizePublishedAt(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function normalizeLegalKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function legalKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeLegalKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function textMatchesKeyword({ title = "", content = "" } = {}, keyword = "") {
  const text = `${title} ${content}`;
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeLegalKeywordText(text);
  const needles = legalKeywordNeedles(keyword);
  if (!needles.length) return true;
  return needles.some((needle) => {
    const normalizedNeedle = normalizeLegalKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function legalRecordKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["legal_record_source", metrics.legal_record_source],
    ["legal_record_type", metrics.legal_record_type],
    ["court", metrics.court],
    ["docket_number", metrics.docket_number],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword({ title: value || "", content: "" }, keyword));
  return match ? match[0] : "";
}

function legalRecordKeywordDiagnostics(item = {}, keyword = "") {
  return {
    legal_matched_keyword: cleanText(keyword, 160),
    legal_keyword_match_source: legalRecordKeywordMatchSource(item, keyword),
  };
}

function legalRecordTermMatches(text = "", terms = []) {
  const source = normalizeLegalKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeLegalKeywordText(term);
    return needle && source.includes(needle);
  });
}

function legalRecordRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const metricText = Object.values(metrics)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => cleanText(value, 400))
    .filter(Boolean)
    .join(" ");
  const text = cleanText(`${item.title || ""} ${item.content || ""} ${item.author || ""} ${metricText}`, 6000).toLowerCase();
  const reasons = [];
  let score = metrics.source_family === "legal" || metrics.source_weight_tier === "public-legal-record" ? 20 : 10;
  const out = {};
  const evidenceTerms = legalRecordTermMatches(text, [
    "docket", "docket number", "case number", "case no", "civil action", "complaint", "exhibit", "affidavit", "declaration", "transcript", "brief", "opinion",
    "案號", "案号", "案卷", "起訴書", "起诉书", "訴狀", "诉状", "證據", "证据", "聲明", "声明", "判決書", "判决书",
  ]);
  const stageTerms = legalRecordTermMatches(text, [
    "filed", "pending", "hearing", "motion", "order", "judgment", "opinion", "settlement", "appeal", "injunction", "certification", "dismissed",
    "立案", "待審", "待审", "聽證", "听证", "動議", "动议", "命令", "判決", "判决", "裁定", "和解", "上訴", "上诉", "禁令", "駁回", "驳回",
  ]);
  const remedyTerms = legalRecordTermMatches(text, [
    "settlement", "restitution", "redress", "damages", "refund", "injunction", "consent decree", "consent judgment", "corrective action", "remediation",
    "和解", "賠償", "赔偿", "退款", "救濟", "救济", "禁令", "同意判決", "同意判决", "整改", "補救", "补救",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("legal_lawsuit_signal", "lawsuit or litigation record", /lawsuit|litigation|suit\b|civil action|court case|complaint|petition|诉讼|訴訟|起诉|起訴/i.test(text), 16);
  addSignal("legal_class_action_signal", "class action or collective claim", /class action|collective action|mass action|multi-district litigation|\bmdl\b|集体诉讼|集體訴訟|集団訴訟/i.test(text), 18);
  addSignal("legal_settlement_signal", "settlement or consent resolution", /settlement|settle|settled|consent decree|consent judgment|stipulated judgment|和解/i.test(text), 12);
  addSignal("legal_judgment_signal", "judgment, order, or opinion", /judgment|judgement|opinion|order|ruling|decision|判决|判決|裁定|命令/i.test(text), 10);
  addSignal("legal_appeal_signal", "appeal or appellate record", /appeal|appellate|circuit court|court of appeals|上诉|上訴|控诉|控訴/i.test(text), 8);
  addSignal("legal_injunction_signal", "injunction or restraining order", /injunction|temporary restraining order|\btro\b|restraining order|preliminary injunction|permanent injunction|禁令|禁止令|差止/i.test(text), 14);
  addSignal("legal_bankruptcy_signal", "bankruptcy or insolvency proceeding", /bankruptcy|chapter 11|chapter 7|insolvency|restructuring|creditor committee|破产|破產|清算|重整/i.test(text), 14);
  addSignal("legal_ip_signal", "intellectual property dispute", /patent|trademark|copyright|trade secret|infringement|dmca|intellectual property|专利|專利|商标|商標|版权|著作权|營業秘密|商业秘密/i.test(text), 10);
  addSignal("legal_consumer_signal", "consumer, refund, or product complaint", /consumer|refund|chargeback|subscription|deceptive|unfair|warranty|defect|product liability|消费者|消費者|退款|欺诈|欺詐|误导|誤導/i.test(text), 12);
  addSignal("legal_employment_signal", "employment or labor dispute", /employment|employee|worker|labor|wage|harassment|discrimination|retaliation|wrongful termination|雇佣|僱傭|劳动|勞動|歧视|歧視/i.test(text), 10);
  addSignal("legal_securities_signal", "securities or investor litigation", /securities|shareholder|investor|stock drop|10b-5|exchange act|sec\b|disclosure|insider trading|证券|證券|股东|股東|投资者|投資者|披露/i.test(text), 14);
  addSignal("legal_antitrust_signal", "competition or antitrust litigation", /antitrust|anti-competitive|anticompetitive|competition law|cartel|price fixing|monopoly|sherman act|clayton act|反垄断|反壟斷|垄断|壟斷|竞争|競爭/i.test(text), 12);
  addSignal("legal_privacy_signal", "privacy, data breach, or cyber litigation", /privacy|data breach|personal data|cybersecurity|cyberattack|ransomware|biometric|ccpa|gdpr|hipaa|个人信息|個人資料|数据泄露|資料外洩|隐私|隱私/i.test(text), 12);
  addSignal("legal_criminal_signal", "criminal case or prosecution", /criminal|indictment|prosecution|guilty plea|sentenced|convicted|felony|fraud conspiracy|刑事|起诉书|起訴書|定罪|判刑/i.test(text), 16);
  addSignal("legal_regulatory_signal", "regulatory or enforcement-related litigation", /regulator|regulatory|enforcement|administrative|agency|attorney general|ftc|sec|cfpb|doj|eeoc|osha|監管|监管|执法|執法|行政/i.test(text), 12);
  addSignal("legal_evidence_language_signal", "docket, filing, exhibit, or opinion evidence language", evidenceTerms.length > 0, 10);
  addSignal("legal_case_stage_signal", "case lifecycle or procedural stage language", stageTerms.length > 0, 10);
  addSignal("legal_remedy_language_signal", "settlement, injunction, damages, or remediation language", remedyTerms.length > 0, 10);

  const semanticSignals = [
    out.legal_lawsuit_signal,
    out.legal_class_action_signal,
    out.legal_settlement_signal,
    out.legal_judgment_signal,
    out.legal_appeal_signal,
    out.legal_injunction_signal,
    out.legal_bankruptcy_signal,
    out.legal_ip_signal,
    out.legal_consumer_signal,
    out.legal_employment_signal,
    out.legal_securities_signal,
    out.legal_antitrust_signal,
    out.legal_privacy_signal,
    out.legal_criminal_signal,
    out.legal_regulatory_signal,
    out.legal_evidence_language_signal,
    out.legal_case_stage_signal,
    out.legal_remedy_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "legal_complete_case_narrative_signal",
    "complete legal case narrative",
    semanticSignals >= 5
      && (out.legal_lawsuit_signal || out.legal_class_action_signal || out.legal_regulatory_signal || out.legal_criminal_signal)
      && (out.legal_evidence_language_signal || out.legal_case_stage_signal)
      && (out.legal_settlement_signal || out.legal_judgment_signal || out.legal_injunction_signal || out.legal_remedy_language_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    legal_risk_score: boundedScore,
    legal_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    legal_signal_count: signalFields.length,
    legal_semantic_signal_count: semanticSignals,
    legal_signal_reasons: [...new Set(reasons)].slice(0, 12),
    legal_evidence_terms: evidenceTerms,
    legal_case_stage_terms: stageTerms,
    legal_remedy_terms: remedyTerms,
  };
}

function textHasLegalContext({ title = "", content = "" } = {}) {
  const text = `${title} ${content}`.toLowerCase();
  return LEGAL_CONTEXT_TERMS.some(term => text.includes(term.toLowerCase()));
}

function courtListenerAbsoluteUrl(value = "") {
  const url = normalizeUrl(value);
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://www.courtlistener.com${url}`;
  return `https://www.courtlistener.com/${url.replace(/^\/+/, "")}`;
}

export function parseCourtListenerSearchResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  const now = new Date();
  for (const item of results) {
    const title = cleanText(item.caseName || item.caseNameFull || item.case_name || item.title || item.absolute_url || "", 300);
    const content = cleanText([
      item.snippet,
      item.syllabus,
      item.procedural_history,
      item.court,
      item.docketNumber || item.docket_number,
      item.status,
    ].filter(Boolean).join(" "), 1400);
    const url = courtListenerAbsoluteUrl(item.absolute_url || item.cluster?.absolute_url || item.docket?.absolute_url || item.resource_uri || "");
    if (!title || !url) continue;
    if (!textMatchesKeyword({ title, content }, keyword)) continue;
    if (!textHasLegalContext({ title, content })) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const publishedAt = normalizePublishedAt(item.dateFiled || item.date_filed || item.dateArgued || item.date_created || item.timestamp);
    if (!isRecentDate(new Date(publishedAt), now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: cleanText(item.court || item.court_citation_string || "CourtListener", 160),
      publishedAt,
      metrics: {
        source: "courtlistener_public_search",
        source_family: "legal",
        source_kind: "courtlistener_public_legal_search",
        collection_mode: "courtlistener_public_json_search",
        legal_record_source: "CourtListener",
        legal_record_type: cleanText(item.type || item.result_type || "court-record", 80),
        court: cleanText(item.court || "", 160),
        docket_number: cleanText(item.docketNumber || item.docket_number || "", 120),
        precedential_status: cleanText(item.status || item.precedential_status || "", 100),
        source_weight_tier: "public-legal-record",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseJustiaSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const blockRegex = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class=["'][^"']*result__a|$)/gi;
  const out = [];
  const seen = new Set();
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const url = normalizeUrl(match[1]);
    const title = cleanText(match[2], 300);
    const content = cleanText((match[3].match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)
      || match[3].match(/<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      || [])[1] || match[3], 1400);
    if (!url || !title || !/justia\.com/i.test(url)) continue;
    if (!textMatchesKeyword({ title, content }, keyword)) continue;
    if (!textHasLegalContext({ title, content })) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const publishedAt = new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: "Justia public legal search",
      publishedAt,
      metrics: {
        source: "justia_duckduckgo_site_search",
        source_family: "legal",
        source_kind: "justia_public_legal_search",
        collection_mode: "duckduckgo_site_search",
        legal_record_source: "Justia",
        legal_record_type: "public-legal-web-result",
        source_weight_tier: "public-legal-record",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function countJustiaRawResults(html = "") {
  return [...String(html || "").matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=/gi)].length;
}

async function insertLegalItems(items = [], { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  let deepPagesUsed = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = legalRecordDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const shouldEnrich = enrich && deepPagesUsed < maxDeepPages;
    const enriched = shouldEnrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: item.content, ai_summary: item.content, enriched: false };
    if (shouldEnrich) deepPagesUsed += 1;
    const content = enriched.content || item.content || "";
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "legal_public_records",
      url: item.url,
      title: item.title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
      keyword,
      keywords: [keyword],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      source_key: "legalPublicRecords",
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: enriched.evidence?.evidence_type || "legal_public_record_result",
        metrics: {
          ...evidenceMetrics,
          ...legalRecordRiskSignals({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: evidenceMetrics,
          }),
          ...legalRecordKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: evidenceMetrics,
          }, keyword),
          legal_canonical_dedupe_key: dedupeKey,
          legal_search_scan_dedupe_key: dedupeKey,
          ...(attribution.length ? {
            failover_attribution: attribution,
            failover_from_sources: failoverFromSources,
          } : {}),
        },
      },
      source_type: "scraper",
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

function courtListenerSearchUrl(keyword = "", { page = 1 } = {}) {
  const params = new URLSearchParams({
    q: `${keyword} ${LEGAL_CONTEXT_TERMS.slice(0, 8).join(" ")}`,
    order_by: "dateFiled desc",
    page: String(Math.max(1, Number(page) || 1)),
  });
  return `https://www.courtlistener.com/api/rest/v4/search/?${params.toString()}`;
}

function justiaSearchUrl(keyword = "", { page = 1 } = {}) {
  const query = `${keyword} lawsuit class action complaint settlement court site:justia.com`;
  const params = new URLSearchParams({
    q: query,
    b: String((Math.max(1, Number(page) || 1) - 1) * 30),
  });
  return `https://duckduckgo.com/html/?${params.toString()}`;
}

export async function scrapeLegalPublicRecords(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const tasks = [];
  for (const keyword of normalizedKeywords) tasks.push({ keyword, source: "courtlistener" }, { keyword, source: "justia" });
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, source }) => {
    let inserted = 0;
    const failures = [];
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const url = source === "courtlistener" ? courtListenerSearchUrl(keyword, { page }) : justiaSearchUrl(keyword, { page });
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": source === "courtlistener" ? "application/json" : "text/html",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${source}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        let rawResultCount = 0;
        let items = [];
        if (source === "courtlistener") {
          const payload = await res.json();
          rawResultCount = Array.isArray(payload?.results) ? payload.results.length : 0;
          items = parseCourtListenerSearchResults(payload, keyword, { limit: remaining, since });
        } else {
          const html = await res.text();
          rawResultCount = countJustiaRawResults(html);
          items = parseJustiaSearchResults(html, keyword, { limit: remaining, since });
        }
        items = items.map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            legal_search_page: page,
            legal_search_source: source,
            legal_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertLegalItems(items, {
          keyword,
          proxyUrl,
          enrich,
          maxDeepPages,
          domainControls,
          contentControls,
          seenItemUrls,
          failoverAttribution,
        });
        inserted += count;
        if (!rawResultCount) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: source, message });
      console.warn(`[CRM/LegalPublicRecords] 抓取失敗 source=${source} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  LEGAL_CONTEXT_TERMS,
  courtListenerSearchUrl,
  justiaSearchUrl,
  normalizeBudget,
  normalizeLegalKeywordText,
  textMatchesKeyword,
  normalizeLegalDedupeUrl,
  legalRecordDedupeKey,
  legalRecordKeywordMatchSource,
  legalRecordKeywordDiagnostics,
  legalRecordRiskSignals,
  countJustiaRawResults,
  parseCourtListenerSearchResults,
  parseJustiaSearchResults,
};
