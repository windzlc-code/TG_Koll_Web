import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_TARGET = 4;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 16;
const DEFAULT_MAX_PAGES_PER_TARGET = 3;

export const REGIONAL_COMPLAINT_TARGETS = [
  {
    key: "taiwanCpc",
    name: "Taiwan Consumer Protection Committee",
    siteQuery: "site:cpc.ey.gov.tw 消費 爭議 投訴",
    hostPattern: /(^|\.)cpc\.ey\.gov\.tw$/i,
    tags: ["taiwan", "official", "consumer-protection", "complaint", "dispute"],
    profiles: ["taiwan", "official", "consumer-protection", "complaint", "dispute"],
    tier: "official-consumer-protection",
  },
  {
    key: "taiwanConsumersFoundation",
    name: "Consumers' Foundation Chinese Taipei",
    siteQuery: "site:consumers.org.tw 消費 投訴 爭議",
    hostPattern: /(^|\.)consumers\.org\.tw$/i,
    tags: ["taiwan", "consumer-protection", "complaint", "dispute"],
    profiles: ["taiwan", "ngo", "consumer-protection", "complaint", "dispute"],
    tier: "consumer-advocacy",
  },
  {
    key: "hongKongConsumerCouncil",
    name: "Hong Kong Consumer Council",
    siteQuery: "site:consumer.org.hk complaint consumer",
    hostPattern: /(^|\.)consumer\.org\.hk$/i,
    tags: ["hong-kong", "consumer-protection", "complaint", "alert"],
    profiles: ["hong-kong", "official", "consumer-protection", "complaint", "alert"],
    tier: "official-consumer-protection",
  },
  {
    key: "caseSingapore",
    name: "CASE Singapore",
    siteQuery: "site:case.org.sg complaint consumer",
    hostPattern: /(^|\.)case\.org\.sg$/i,
    tags: ["singapore", "consumer-protection", "complaint", "dispute"],
    profiles: ["singapore", "ngo", "consumer-protection", "complaint", "dispute"],
    tier: "consumer-advocacy",
  },
  {
    key: "australiaAccc",
    name: "ACCC",
    siteQuery: "site:accc.gov.au consumer complaint product safety",
    hostPattern: /(^|\.)accc\.gov\.au$/i,
    tags: ["australia", "official", "consumer-protection", "regulatory", "complaint"],
    profiles: ["australia", "official", "consumer-protection", "regulatory", "complaint"],
    tier: "regulatory",
  },
  {
    key: "usCfpb",
    name: "Consumer Financial Protection Bureau",
    siteQuery: "site:consumerfinance.gov complaint consumer financial",
    hostPattern: /(^|\.)consumerfinance\.gov$/i,
    tags: ["us", "official", "consumer-protection", "financial", "complaint", "regulatory"],
    profiles: ["us", "official", "consumer-protection", "financial", "complaint", "regulatory"],
    tier: "regulatory",
  },
  {
    key: "usCpsc",
    name: "U.S. Consumer Product Safety Commission",
    siteQuery: "site:cpsc.gov recalls product safety warning",
    hostPattern: /(^|\.)cpsc\.gov$/i,
    tags: ["us", "official", "product-safety", "recall", "warning", "regulatory"],
    profiles: ["us", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "usFtcConsumer",
    name: "FTC Consumer Advice and Alerts",
    siteQuery: "site:consumer.ftc.gov scam refund complaint consumer alert",
    hostPattern: /(^|\.)consumer\.ftc\.gov$/i,
    tags: ["us", "official", "consumer-protection", "scam", "fraud", "alert", "regulatory"],
    profiles: ["us", "official", "consumer-protection", "scam", "fraud", "alert", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "usFtcReportFraud",
    name: "FTC ReportFraud",
    siteQuery: "site:reportfraud.ftc.gov fraud scam complaint",
    hostPattern: /(^|\.)reportfraud\.ftc\.gov$/i,
    tags: ["us", "official", "consumer-protection", "scam", "fraud", "complaint", "regulatory"],
    profiles: ["us", "official", "consumer-protection", "scam", "fraud", "complaint", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "canadaRecalls",
    name: "Canada Recalls and Safety Alerts",
    siteQuery: "site:recalls-rappels.canada.ca recall safety alert consumer",
    hostPattern: /(^|\.)recalls-rappels\.canada\.ca$/i,
    tags: ["canada", "official", "product-safety", "recall", "alert", "regulatory"],
    profiles: ["canada", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "euSafetyGate",
    name: "EU Safety Gate",
    siteQuery: "site:ec.europa.eu/safety-gate-alerts safety gate recall dangerous product",
    hostPattern: /(^|\.)ec\.europa\.eu$/i,
    tags: ["eu", "official", "product-safety", "recall", "dangerous-product", "regulatory"],
    profiles: ["eu", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "ukProductSafety",
    name: "UK Product Safety Alerts Reports and Recalls",
    siteQuery: "site:gov.uk/product-safety-alerts-reports-recalls product safety recall",
    hostPattern: /(^|\.)gov\.uk$/i,
    tags: ["uk", "official", "product-safety", "recall", "alert", "regulatory"],
    profiles: ["uk", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "australiaProductSafety",
    name: "Product Safety Australia",
    siteQuery: "site:productsafety.gov.au/recalls recall product safety",
    hostPattern: /(^|\.)productsafety\.gov\.au$/i,
    tags: ["australia", "official", "product-safety", "recall", "alert", "regulatory"],
    profiles: ["australia", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    tier: "regulatory-alert",
  },
  {
    key: "japanCaa",
    name: "Japan Consumer Affairs Agency",
    siteQuery: "site:caa.go.jp consumer safety recall complaint",
    hostPattern: /(^|\.)caa\.go\.jp$/i,
    tags: ["japan", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    profiles: ["japan", "official", "consumer-protection", "product-safety", "recall", "regulatory"],
    tier: "regulatory",
  },
  {
    key: "australiaScamwatch",
    name: "Scamwatch",
    siteQuery: "site:scamwatch.gov.au scam complaint consumer",
    hostPattern: /(^|\.)scamwatch\.gov\.au$/i,
    tags: ["australia", "official", "scam", "consumer-protection", "alert"],
    profiles: ["australia", "official", "scam", "consumer-protection", "alert"],
    tier: "regulatory-alert",
  },
  {
    key: "ukCitizensAdvice",
    name: "Citizens Advice Consumer",
    siteQuery: "site:citizensadvice.org.uk consumer complaint refund",
    hostPattern: /(^|\.)citizensadvice\.org\.uk$/i,
    tags: ["uk", "consumer-protection", "complaint", "refund"],
    profiles: ["uk", "consumer-protection", "complaint", "refund"],
    tier: "consumer-advocacy",
  },
  {
    key: "ukTradingStandards",
    name: "Trading Standards UK",
    siteQuery: "site:tradingstandards.uk consumer complaint",
    hostPattern: /(^|\.)tradingstandards\.uk$/i,
    tags: ["uk", "consumer-protection", "regulatory", "complaint"],
    profiles: ["uk", "official", "consumer-protection", "regulatory", "complaint"],
    tier: "regulatory",
  },
  {
    key: "nzConsumerProtection",
    name: "New Zealand Consumer Protection",
    siteQuery: "site:consumerprotection.govt.nz complaint refund consumer",
    hostPattern: /(^|\.)consumerprotection\.govt\.nz$/i,
    tags: ["new-zealand", "official", "consumer-protection", "complaint", "refund"],
    profiles: ["new-zealand", "official", "consumer-protection", "complaint", "refund"],
    tier: "official-consumer-protection",
  },
  {
    key: "indiaConsumerHelpline",
    name: "India National Consumer Helpline",
    siteQuery: "site:consumerhelpline.gov.in complaint consumer grievance",
    hostPattern: /(^|\.)consumerhelpline\.gov\.in$/i,
    tags: ["india", "official", "consumer-protection", "complaint", "grievance"],
    profiles: ["india", "official", "consumer-protection", "complaint", "dispute"],
    tier: "official-consumer-protection",
  },
  {
    key: "koreaConsumerAgency",
    name: "Korea Consumer Agency",
    siteQuery: "site:kca.go.kr consumer complaint safety recall",
    hostPattern: /(^|\.)kca\.go\.kr$/i,
    tags: ["korea", "official", "consumer-protection", "complaint", "product-safety", "recall"],
    profiles: ["korea", "official", "consumer-protection", "complaint", "product-safety", "recall", "regulatory"],
    tier: "regulatory",
  },
  {
    key: "brazilConsumidorGov",
    name: "Brazil Consumidor.gov.br",
    siteQuery: "site:consumidor.gov.br reclamacao consumidor empresa",
    hostPattern: /(^|\.)consumidor\.gov\.br$/i,
    tags: ["brazil", "latin-america", "official", "consumer-protection", "complaint", "dispute"],
    profiles: ["brazil", "latin-america", "official", "consumer-protection", "complaint", "dispute"],
    tier: "official-consumer-protection",
  },
  {
    key: "mexicoProfeco",
    name: "Mexico PROFECO",
    siteQuery: "site:gob.mx/profeco queja consumidor alerta",
    hostPattern: /(^|\.)gob\.mx$/i,
    tags: ["mexico", "latin-america", "official", "consumer-protection", "complaint", "alert"],
    profiles: ["mexico", "latin-america", "official", "consumer-protection", "complaint", "alert"],
    tier: "official-consumer-protection",
  },
  {
    key: "franceSignalConso",
    name: "France SignalConso",
    siteQuery: "site:signal.conso.gouv.fr signalement consommateur reclamation",
    hostPattern: /(^|\.)signal\.conso\.gouv\.fr$/i,
    tags: ["france", "eu", "official", "consumer-protection", "complaint", "dispute"],
    profiles: ["france", "eu", "official", "consumer-protection", "complaint", "dispute"],
    tier: "official-consumer-protection",
  },
  {
    key: "germanyVerbraucherzentrale",
    name: "Verbraucherzentrale Germany",
    siteQuery: "site:verbraucherzentrale.de beschwerde verbraucher warnung",
    hostPattern: /(^|\.)verbraucherzentrale\.de$/i,
    tags: ["germany", "eu", "consumer-protection", "complaint", "warning"],
    profiles: ["germany", "eu", "consumer-protection", "complaint", "warning"],
    tier: "consumer-advocacy",
  },
  {
    key: "spainOcu",
    name: "OCU Spain",
    siteQuery: "site:ocu.org reclamacion consumidor alerta",
    hostPattern: /(^|\.)ocu\.org$/i,
    tags: ["spain", "eu", "consumer-protection", "complaint", "alert"],
    profiles: ["spain", "eu", "consumer-protection", "complaint", "alert"],
    tier: "consumer-advocacy",
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

function normalizeRegionalComplaintDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  try {
    const url = new URL(normalized);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeRegionalComplaintDedupeUrl(embedded);
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

function regionalComplaintDedupeKey(item = {}) {
  return normalizeRegionalComplaintDedupeUrl(item.url || item.link || "");
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
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(REGIONAL_COMPLAINT_TARGETS.length, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
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
  const targetValues = new Set([
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
    target.tier || "",
    target.key || "",
    target.name || "",
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  return profiles.some(profile => targetValues.has(profile));
}

function normalizeTargets(targets = [], targetProfiles = []) {
  const configured = Array.isArray(targets) ? targets.map(item => String(item || "").trim()).filter(Boolean) : [];
  const candidates = REGIONAL_COMPLAINT_TARGETS.filter(target => targetMatchesProfiles(target, targetProfiles));
  const fallback = candidates.length ? candidates : REGIONAL_COMPLAINT_TARGETS;
  if (!configured.length) return fallback;
  const wanted = new Set(configured.map(item => item.toLowerCase()));
  const selected = fallback.filter(target => wanted.has(target.key.toLowerCase()) || wanted.has(target.name.toLowerCase()));
  return selected.length ? selected : fallback;
}

function normalizeDirectUrls(directUrls = []) {
  return [...new Set((Array.isArray(directUrls) ? directUrls : [])
    .map(url => normalizeRegionalComplaintDedupeUrl(url))
    .filter(url => /^https?:\/\//i.test(url)))].slice(0, 50);
}

function directRegionalComplaintTargets(directUrls = [], candidateTargets = []) {
  const targets = Array.isArray(candidateTargets) && candidateTargets.length ? candidateTargets : REGIONAL_COMPLAINT_TARGETS;
  const seen = new Set();
  const out = [];
  for (const url of normalizeDirectUrls(directUrls)) {
    const target = targets.find(candidate => hostMatches(url, candidate.hostPattern));
    if (!target) continue;
    const dedupeKey = `${target.key}:${normalizeRegionalComplaintDedupeUrl(url)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ url, target });
  }
  return out;
}

const TOPIC_HINTS = [
  { topic: "recall", pattern: /recall|召回|回收|product safety|產品安全|产品安全|safety alert|危險商品|危险商品|dangerous product/i, profiles: ["recall", "product-safety", "regulatory"], terms: ["recall", "safety", "product"] },
  { topic: "financial", pattern: /financial|finance|bank|loan|credit|payment|billing|chargeback|金融|銀行|银行|貸款|贷款|信用|付款|支付|扣款|帳單|账单/i, profiles: ["financial", "complaint", "regulatory"], terms: ["financial", "payment", "complaint"] },
  { topic: "scam", pattern: /scam|fraud|phishing|詐騙|诈骗|詐欺|欺詐|欺诈|釣魚|钓鱼/i, profiles: ["scam", "alert", "regulatory"], terms: ["scam", "fraud", "alert"] },
  { topic: "uk", pattern: /uk\b|united kingdom|britain|英國|英国/i, profiles: ["uk", "consumer-protection", "regulatory", "recall"], terms: ["consumer", "complaint", "recall"] },
  { topic: "australia", pattern: /australia|澳洲|澳大利亞|澳大利亚/i, profiles: ["australia", "consumer-protection", "regulatory", "recall"], terms: ["consumer", "complaint", "recall"] },
  { topic: "new-zealand", pattern: /new zealand|nz\b|紐西蘭|新西兰/i, profiles: ["new-zealand", "consumer-protection", "complaint"], terms: ["consumer", "complaint"] },
  { topic: "india", pattern: /india|印度/i, profiles: ["india", "consumer-protection", "complaint"], terms: ["consumer", "complaint", "grievance"] },
  { topic: "korea", pattern: /korea|韓國|韩国/i, profiles: ["korea", "consumer-protection", "regulatory"], terms: ["consumer", "complaint", "safety"] },
  { topic: "taiwan", pattern: /taiwan|台灣|台湾|臺灣|消保會|消保/i, profiles: ["taiwan", "consumer-protection", "complaint"], terms: ["消費", "投訴", "爭議"] },
  { topic: "hong-kong", pattern: /hong kong|香港|消委會|消委会/i, profiles: ["hong-kong", "consumer-protection", "complaint"], terms: ["complaint", "consumer"] },
  { topic: "japan", pattern: /japan|日本|消費者庁|消費者廳/i, profiles: ["japan", "consumer-protection", "regulatory"], terms: ["consumer", "safety"] },
  { topic: "canada", pattern: /canada|加拿大/i, profiles: ["canada", "recall", "regulatory"], terms: ["recall", "safety"] },
  { topic: "eu", pattern: /europe|european|eu\b|歐盟|欧盟/i, profiles: ["eu", "recall", "regulatory"], terms: ["safety", "recall"] },
  { topic: "brazil", pattern: /brazil|brasil|巴西|reclama(?:c|ç)(?:a|ã)o|reclamação/i, profiles: ["brazil", "latin-america", "consumer-protection", "complaint"], terms: ["reclamacao", "consumidor", "empresa"] },
  { topic: "mexico", pattern: /mexico|méxico|墨西哥|profeco|queja/i, profiles: ["mexico", "latin-america", "consumer-protection", "complaint", "alert"], terms: ["queja", "consumidor", "alerta"] },
  { topic: "latin-america", pattern: /latin america|latam|latinoam[eé]rica|拉美|拉丁美洲|consumidor|reclamaci[oó]n/i, profiles: ["latin-america", "consumer-protection", "complaint"], terms: ["consumidor", "reclamacion", "queja"] },
  { topic: "france", pattern: /france|french|法國|法国|signalconso|signalement|r[eé]clamation/i, profiles: ["france", "eu", "consumer-protection", "complaint"], terms: ["signalement", "consommateur", "reclamation"] },
  { topic: "germany", pattern: /germany|deutschland|德國|德国|verbraucherzentrale|beschwerde/i, profiles: ["germany", "eu", "consumer-protection", "complaint", "warning"], terms: ["beschwerde", "verbraucher", "warnung"] },
  { topic: "spain", pattern: /spain|españa|espana|西班牙|ocu|reclamaci[oó]n/i, profiles: ["spain", "eu", "consumer-protection", "complaint", "alert"], terms: ["reclamacion", "consumidor", "alerta"] },
];

function targetKeywordScore(target = {}, keyword = "") {
  const text = String(keyword || "");
  const targetValues = new Set([
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
    target.tier || "",
    target.key || "",
    target.name || "",
    target.siteQuery || "",
  ].map(item => String(item || "").toLowerCase()));
  let score = 0;
  for (const hint of TOPIC_HINTS) {
    if (!hint.pattern.test(text)) continue;
    const profileHits = hint.profiles.filter(profile => targetValues.has(profile.toLowerCase())).length;
    const termHits = hint.terms.filter(term => String(target.siteQuery || "").toLowerCase().includes(term.toLowerCase())).length;
    score += profileHits * 18 + termHits * 6;
  }
  if (/complaint|投訴|投诉|客訴|客诉|爭議|争议|refund|退款|退費|退费/i.test(text)) {
    if (targetValues.has("complaint")) score += 12;
    if (targetValues.has("consumer-protection")) score += 8;
  }
  if (/official|regulatory|監管|监管|官方/i.test(text)) {
    if (targetValues.has("official")) score += 10;
    if (targetValues.has("regulatory")) score += 10;
  }
  if (/regulatory-alert|official-consumer-protection/i.test(String(target.tier || ""))) score += 3;
  return score;
}

function rankTargetsForKeyword(targets = [], keyword = "") {
  return [...targets].sort((a, b) => targetKeywordScore(b, keyword) - targetKeywordScore(a, keyword)
    || REGIONAL_COMPLAINT_TARGETS.findIndex(target => target.key === a.key) - REGIONAL_COMPLAINT_TARGETS.findIndex(target => target.key === b.key)
    || String(a.key).localeCompare(String(b.key)));
}

function buildRegionalComplaintQuery(keyword = "", target = {}) {
  const matchedHints = TOPIC_HINTS.filter(hint => hint.pattern.test(String(keyword || "")));
  const dynamicTerms = matchedHints.flatMap(hint => hint.terms);
  const baseTerms = ["complaint", "consumer", "dispute", "refund", "service"];
  return [...new Set([keyword, ...dynamicTerms, ...baseTerms, target.siteQuery].filter(Boolean))]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostMatches(url, pattern) {
  try {
    return pattern.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function normalizeRegionalComplaintKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function regionalComplaintKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeRegionalComplaintKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function regionalComplaintValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeRegionalComplaintKeywordText(value);
  return regionalComplaintKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeRegionalComplaintKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function parseRegionalComplaintSearchResults(html, keyword, target, limit = DEFAULT_MAX_ITEMS_PER_TARGET) {
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
    if (!regionalComplaintValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
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

function regionalComplaintKeywordMatchSource(item = {}, keyword = "", target = {}) {
  if (!regionalComplaintKeywordNeedles(keyword).length) return "";
  if (regionalComplaintValueMatchesKeyword(item.title, keyword)) return "title";
  if (regionalComplaintValueMatchesKeyword(item.content, keyword)) return "snippet";
  if (regionalComplaintValueMatchesKeyword(item.url, keyword)) return "url";
  const targetText = [
    target.name,
    target.key,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  if (regionalComplaintValueMatchesKeyword(targetText, keyword)) return "target_metadata";
  return "search_query";
}

function directRegionalComplaintItem(url = "", keyword = "", target = {}) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return target.name || "regional complaint source";
    }
  })();
  return {
    url,
    title: `${cleanText(keyword, 120)} ${target.name || host} complaint record`.trim(),
    content: `${cleanText(keyword, 120)} consumer complaint or regulatory record from ${target.name || host}`,
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

function regionalComplaintTermMatches(text = "", terms = []) {
  const source = normalizeRegionalComplaintKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeRegionalComplaintKeywordText(term);
    return needle && source.includes(needle);
  });
}

function regionalComplaintRiskSignals({ item = {}, target = {}, content = "", metrics = {} } = {}) {
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
  const official = /official|regulatory|government|gov|consumer-protection|regulatory-alert|官方|監管|监管|政府|消保/i.test(targetText);
  const reasons = [];
  let score = official ? 22 : 12;
  const out = {};
  const evidenceTerms = regionalComplaintTermMatches(text, [
    "case number", "complaint number", "reference number", "receipt", "invoice", "contract", "evidence", "screenshot", "documents", "timeline",
    "案件編號", "案件编号", "申訴編號", "申诉编号", "投訴編號", "投诉编号", "收據", "收据", "發票", "发票", "合約", "合同", "證據", "证据", "文件", "時間線", "时间线",
  ]);
  const agencyActionTerms = regionalComplaintTermMatches(text, [
    "mediation", "investigation", "accepted", "case opened", "order", "warning letter", "recall notice", "consumer alert", "resolution",
    "調解", "调解", "立案", "受理", "調查", "调查", "命令", "警示", "警告信", "召回通知", "消費警訊", "消费警示", "處理結果", "处理结果",
  ]);
  const enforcementTerms = regionalComplaintTermMatches(text, [
    "fine", "penalty", "sanction", "enforcement", "prosecution", "administrative action", "ban", "ordered to stop",
    "罰款", "罚款", "處罰", "处罚", "制裁", "執法", "执法", "起訴", "起诉", "行政處分", "行政处罚", "勒令停止", "禁令",
  ]);
  const spreadTerms = regionalComplaintTermMatches(text, [
    "cross-border", "international", "multiple complaints", "media coverage", "press release", "public warning", "social media",
    "跨境", "國際", "国际", "多起投訴", "多起投诉", "媒體報導", "媒体报道", "新聞", "新闻", "新聞稿", "新闻稿", "公開警示", "公开警示", "社媒",
  ]);
  const responseTerms = regionalComplaintTermMatches(text, [
    "official response", "agency response", "company response", "business response", "case resolved", "resolution", "settlement",
    "refund ordered", "corrective action", "remediation", "consumer redress", "response published",
    "官方回應", "官方回应", "機關回覆", "机关回复", "主管機關回覆", "主管机关回复", "企業回應", "企业回应",
    "業者回應", "业者回应", "案件結案", "案件结案", "處理結果", "处理结果", "和解", "命令退款", "改善措施", "消費者救濟", "消费者救济",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("regional_complaint_official_signal", "official or regulator-backed source", official, 12);
  addSignal("regional_complaint_consumer_dispute_signal", "consumer complaint or dispute", /complaint|consumer dispute|grievance|reclamation|reclamacao|reclamação|queja|beschwerde|signalement|投訴|投诉|客訴|客诉|消費爭議|消费争议|申訴|申诉/i.test(text), 14);
  addSignal("regional_complaint_refund_signal", "refund or payment dispute", /refund|chargeback|billing|payment|overcharge|unauthorized charge|退款|退費|退费|扣款|支付|付款|帳單|账单/i.test(text), 12);
  addSignal("regional_complaint_customer_service_signal", "customer service or response failure", /customer service|customer support|no response|unresolved|ignored|response delay|客服|售後|售后|未回覆|未回复|無回應|无回应|未處理|未处理/i.test(text), 10);
  addSignal("regional_complaint_scam_fraud_signal", "scam, fraud, or deceptive practice alert", /scam|fraud|phishing|deceptive|misleading|fake|alert|warning|詐騙|诈骗|欺詐|欺诈|釣魚|钓鱼|誤導|误导|警示|警告/i.test(text), 16);
  addSignal("regional_complaint_product_safety_signal", "product safety, recall, or dangerous product", /recall|product safety|safety alert|dangerous product|unsafe|injury|hazard|召回|產品安全|产品安全|危險商品|危险商品|安全警示|受傷|受伤/i.test(text), 16);
  addSignal("regional_complaint_financial_signal", "financial services or billing protection issue", /financial|finance|bank|loan|credit|debt|payment|billing|cfpb|金融|銀行|银行|貸款|贷款|信用|債務|债务|支付/i.test(text), 12);
  addSignal("regional_complaint_privacy_signal", "privacy, personal data, or security complaint", /privacy|personal data|data breach|security|hacked|個資|个人信息|個人資料|資料外洩|数据泄露|隱私|隐私|帳號被盜|账号被盗/i.test(text), 12);
  addSignal("regional_complaint_enforcement_signal", "enforcement or regulatory action context", /enforcement|regulatory action|investigation|penalty|fine|sanction|ordered|監管|监管|執法|执法|調查|调查|处罚|處罰|罚款|罰款/i.test(text), 14);
  addSignal("regional_complaint_evidence_language_signal", "case, receipt, document, or timeline evidence language", evidenceTerms.length > 0, 12);
  addSignal("regional_complaint_agency_action_signal", "agency mediation, investigation, alert, or resolution language", agencyActionTerms.length > 0, 12);
  addSignal("regional_complaint_enforcement_action_signal", "fine, sanction, prosecution, or order language", enforcementTerms.length > 0, 14);
  addSignal("regional_complaint_spread_language_signal", "cross-border, media, public-warning, or multi-complaint language", spreadTerms.length > 0, 10);
  addSignal("regional_complaint_response_language_signal", "official, agency, company, or resolution response language", responseTerms.length > 0, 10);

  const semanticSignals = [
    out.regional_complaint_consumer_dispute_signal,
    out.regional_complaint_refund_signal,
    out.regional_complaint_customer_service_signal,
    out.regional_complaint_scam_fraud_signal,
    out.regional_complaint_product_safety_signal,
    out.regional_complaint_financial_signal,
    out.regional_complaint_privacy_signal,
    out.regional_complaint_enforcement_signal,
    out.regional_complaint_evidence_language_signal,
    out.regional_complaint_agency_action_signal,
    out.regional_complaint_enforcement_action_signal,
    out.regional_complaint_spread_language_signal,
    out.regional_complaint_response_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "regional_complaint_complete_case_narrative_signal",
    "complete regional complaint case narrative",
    semanticSignals >= 5
      && (out.regional_complaint_consumer_dispute_signal || out.regional_complaint_scam_fraud_signal || out.regional_complaint_product_safety_signal)
      && (out.regional_complaint_evidence_language_signal || out.regional_complaint_agency_action_signal)
      && (out.regional_complaint_response_language_signal || out.regional_complaint_enforcement_action_signal || out.regional_complaint_spread_language_signal),
    10,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    regional_complaint_risk_score: boundedScore,
    regional_complaint_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    regional_complaint_signal_count: signalFields.length,
    regional_complaint_semantic_signal_count: semanticSignals,
    regional_complaint_signal_reasons: [...new Set(reasons)].slice(0, 16),
    regional_complaint_evidence_terms: evidenceTerms,
    regional_complaint_agency_action_terms: agencyActionTerms,
    regional_complaint_enforcement_action_terms: enforcementTerms,
    regional_complaint_spread_terms: spreadTerms,
    regional_complaint_response_terms: responseTerms,
  };
}

function evidenceWithRegionalMetadata(evidence = {}, item = {}, target = {}, failoverAttribution = [], content = "") {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const evidenceMetrics = evidence?.metrics || {};
  return {
    ...(evidence || {}),
    source_key: "regionalComplaintSources",
    evidence_type: "regional_complaint_source_result",
    metrics: {
      ...evidenceMetrics,
      ...regionalComplaintRiskSignals({ item, target, content, metrics: evidenceMetrics }),
      source: "regional_complaint_source_search",
      regional_source: target.name || item.targetName || "",
      regional_source_key: target.key || item.targetKey || "",
      site_tags: Array.isArray(target.tags) ? target.tags : item.targetTags || [],
      target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
      source_weight_tier: target.tier || "",
      source_family: "review",
      complaint_or_regulatory: true,
      regional_complaint_canonical_dedupe_url: regionalComplaintDedupeKey(item),
      regional_complaint_search_scan_dedupe_key: regionalComplaintDedupeKey(item),
      regional_complaint_search_page: Math.max(1, Number(item.searchPage) || 1),
      regional_complaint_search_raw_result_count: Math.max(0, Number(item.searchRawResultCount) || 0),
      regional_complaint_matched_keyword: item.matchedKeyword || "",
      regional_complaint_keyword_match_source: regionalComplaintKeywordMatchSource(item, item.matchedKeyword || "", target),
      ...(item.directUrl ? {
        source: "regional_complaint_source_direct_url",
        collection_mode: "regional_complaint_direct_url",
        regional_complaint_direct_url: normalizeRegionalComplaintDedupeUrl(item.url),
      } : {}),
      ...(attribution.length ? {
        failover_attribution: attribution,
        failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
      } : {}),
    },
  };
}

async function insertRegionalItems(items, { keyword, proxyUrl, enrich, target, domainControls = {}, contentControls = {}, failoverAttribution = [], seenItemUrls = null }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = regionalComplaintDedupeKey(item);
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
      platform: "regional_complaint_sources",
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
      evidence: evidenceWithRegionalMetadata(enriched.evidence || {}, item, target, failoverAttribution, content),
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

export async function scrapeRegionalComplaintSources(keywords, { proxyUrl = "", enrich = true, budget = {}, targets = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const candidateTargets = normalizeTargets(targets, targetProfiles);
  const directTargets = directRegionalComplaintTargets(directUrls, candidateTargets);
  const tasks = normalizedKeywords.flatMap(keyword => rankTargetsForKeyword(candidateTargets, keyword)
    .slice(0, normalizedBudget.maxTargetsPerKeyword)
    .map(target => ({ keyword, target })));
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    const query = buildRegionalComplaintQuery(keyword, target);
    try {
      const directItems = directTargets
        .filter(item => item.target.key === target.key)
        .slice(0, normalizedBudget.maxItemsPerTarget)
        .map(item => directRegionalComplaintItem(item.url, keyword, target));
      inserted += await insertRegionalItems(directItems, { keyword, proxyUrl, enrich: true, target, domainControls, contentControls, failoverAttribution, seenItemUrls });
      const found = [];
      const seenUrls = new Set();
      for (let page = 0; page < normalizedBudget.maxPagesPerTarget && found.length < normalizedBudget.maxItemsPerTarget; page += 1) {
        const params = new URLSearchParams({ q: query, kl: "us-en" });
        if (page > 0) params.set("s", String(page * 30));
        const url = `https://duckduckgo.com/html/?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-TW,zh-Hant;q=0.9,en-US;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: target.name, page: page + 1, message: httpFailure(res) });
          break;
        }
        const html = await res.text();
        const rawCount = countDuckDuckGoRawResults(html);
        const items = parseRegionalComplaintSearchResults(html, keyword, target, normalizedBudget.maxItemsPerTarget - found.length);
        let pageFound = 0;
        for (const item of items) {
          const dedupeKey = regionalComplaintDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          found.push({ ...item, searchPage: page + 1, searchRawResultCount: rawCount, matchedKeyword: keyword });
          pageFound += 1;
          if (found.length >= normalizedBudget.maxItemsPerTarget) break;
        }
        if (!pageFound && !rawCount) break;
      }
      inserted += await insertRegionalItems(found, { keyword, proxyUrl, enrich, target, domainControls, contentControls, failoverAttribution, seenItemUrls });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.name, message });
      console.warn(`[CRM/RegionalComplaintSources] 抓取失敗 keyword=${keyword} target=${target.name}: ${message}`);
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
  normalizeProfileValues,
  normalizeTargets,
  rankTargetsForKeyword,
  targetKeywordScore,
  buildRegionalComplaintQuery,
  targetMatchesProfiles,
  normalizeDirectUrls,
  directRegionalComplaintTargets,
  directRegionalComplaintItem,
  normalizeRegionalComplaintKeywordText,
  regionalComplaintValueMatchesKeyword,
  normalizeRegionalComplaintDedupeUrl,
  regionalComplaintDedupeKey,
  countDuckDuckGoRawResults,
  parseRegionalComplaintSearchResults,
  regionalComplaintKeywordMatchSource,
  regionalComplaintRiskSignals,
  REGIONAL_COMPLAINT_TARGETS,
};
