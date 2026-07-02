import { isAfterSince, isRecentDate, isTaiwanRelatedText } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 4;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const PUBLIC_SEARCH_ENGINES = ["duckduckgo", "bing_rss"];
const PUBLIC_SEARCH_PROFILES = [
  { key: "taiwan_zh_hant", region: "taiwan", language: "zh-Hant", queryTerms: ["台灣"], duckduckgoKl: "tw-tzh", acceptLanguage: "zh-TW,zh-Hant;q=0.9,en;q=0.8" },
  { key: "global_en", region: "global", language: "en", queryTerms: [], duckduckgoKl: "us-en", acceptLanguage: "en-US,en;q=0.9" },
];
const GDELT_QUERY_PROFILES = [
  { key: "taiwan_zh_hant", region: "taiwan", language: "zh-Hant", terms: ["台灣", "Taiwan"] },
  { key: "global_en", region: "global", language: "en", terms: [] },
  { key: "hong_kong_zh_hant", region: "hong_kong", language: "zh-Hant", terms: ["香港", "Hong Kong"] },
  { key: "mainland_china_zh_hans", region: "mainland_china", language: "zh-Hans", terms: ["中国", "中國", "Mainland China", "China"] },
  { key: "japan_ja", region: "japan", language: "ja", terms: ["台湾", "Taiwan"] },
  { key: "korea_ko", region: "korea", language: "ko", terms: ["대만", "Taiwan"] },
  { key: "singapore_en", region: "singapore", language: "en", terms: ["Singapore"] },
  { key: "india_en", region: "india", language: "en", terms: ["India"] },
  { key: "southeast_asia_en", region: "southeast_asia", language: "en", terms: ["Singapore", "Malaysia", "Indonesia", "Thailand", "Philippines", "Vietnam"] },
  { key: "europe_en", region: "europe", language: "en", terms: ["Europe", "EU", "United Kingdom", "Germany", "France"] },
  { key: "latin_america_es", region: "latin_america", language: "es", terms: ["América Latina", "Mexico", "Brasil", "Argentina", "Colombia"] },
];
const GDELT_PROFILE_COUNTRY_HINTS = new Map([
  ["taiwan", ["TW"]],
  ["hong_kong", ["HK"]],
  ["mainland_china", ["CN", "CH"]],
  ["japan", ["JP", "JA"]],
  ["korea", ["KR", "KS"]],
  ["singapore", ["SG"]],
  ["india", ["IN"]],
  ["southeast_asia", ["SG", "MY", "ID", "TH", "PH", "VN", "VM"]],
  ["europe", ["GB", "UK", "IE", "DE", "FR", "IT", "ES", "NL", "BE", "SE", "NO", "DK", "FI", "PL", "CH", "AT", "EU"]],
  ["latin_america", ["MX", "BR", "AR", "CL", "CO", "PE", "VE", "UY", "EC"]],
]);
const GDELT_RISK_QUERY_TEMPLATES = [
  { key: "complaint_refund", terms: ["complaint", "refund", "dispute", "投訴", "投诉", "客訴", "退款"] },
  { key: "fraud_scam", terms: ["scam", "fraud", "phishing", "詐騙", "诈骗", "欺詐", "欺诈"] },
  { key: "safety_recall", terms: ["recall", "safety alert", "warning", "召回", "安全警示", "風險", "风险"] },
  { key: "crisis_response", terms: ["statement", "response", "apology", "boycott", "聲明", "声明", "回應", "回应", "抵制"] },
];

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.min(50, Math.max(1, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.min(5, Math.max(1, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function normalizeGdeltDeepBudget(deepBudget = {}) {
  const raw = deepBudget && typeof deepBudget === "object" ? deepBudget : {};
  const maxTimelineQueries = Math.round(Number(raw.maxTimelineQueriesPerKeyword ?? raw.max_timeline_queries_per_keyword ?? raw.maxTimelineQueries ?? raw.max_timeline_queries ?? 0));
  const enabled = raw.riskQueryExpansion ?? raw.risk_query_expansion ?? raw.enableRiskQueries ?? raw.enable_risk_queries ?? true;
  const maxRiskQueries = Math.round(Number(raw.maxRiskQueriesPerKeyword ?? raw.max_risk_queries_per_keyword ?? raw.maxRiskQueries ?? raw.max_risk_queries ?? 1));
  return {
    maxTimelineQueriesPerKeyword: Number.isFinite(maxTimelineQueries) ? Math.max(0, Math.min(3, maxTimelineQueries)) : 0,
    riskQueryExpansion: enabled !== false,
    maxRiskQueriesPerKeyword: Number.isFinite(maxRiskQueries) ? Math.max(0, Math.min(GDELT_RISK_QUERY_TEMPLATES.length, maxRiskQueries)) : 1,
  };
}

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

function stripTags(html) {
  return decodeHtml(String(html || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(block = "", tag = "") {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(String(match[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
}

function normalizeUrl(rawUrl) {
  const decoded = decodeHtml(rawUrl || "");
  try {
    const url = new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return normalizeUrl(decodeURIComponent(uddg));
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizePublicSearchDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of [
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
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/amp\/?$/i, "").replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizePublishedAt(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function compactKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function publicSearchMatchesKeyword(text = "", keyword = "") {
  const rawNeedle = String(keyword || "").trim();
  if (!rawNeedle) return false;
  const lower = String(text || "").toLowerCase();
  const needle = rawNeedle.toLowerCase();
  if (lower.includes(needle)) return true;
  const compactText = compactKeywordText(text);
  const compactNeedle = compactKeywordText(rawNeedle);
  return compactNeedle.length >= 2 && compactText.includes(compactNeedle);
}

function normalizePublicSearchProfiles(profiles = ["taiwan_zh_hant"]) {
  const wanted = Array.isArray(profiles) && profiles.length ? profiles : ["taiwan_zh_hant"];
  const keys = new Set(wanted.map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  const out = PUBLIC_SEARCH_PROFILES.filter(profile => keys.has(profile.key.toLowerCase()));
  return out.length ? out : PUBLIC_SEARCH_PROFILES.filter(profile => profile.key === "taiwan_zh_hant");
}

function publicSearchProfileAllows(item = {}, profile = PUBLIC_SEARCH_PROFILES[0]) {
  if (profile?.region === "global") return true;
  return isTaiwanRelatedText(item.title, item.content, item.url, item.author);
}

function publicSearchProfileQuery(keyword = "", profile = PUBLIC_SEARCH_PROFILES[0]) {
  const term = String(keyword || "").trim();
  const queryTerms = (profile?.queryTerms || []).filter(Boolean);
  if (!term) return "";
  return queryTerms.length ? `${term} ${queryTerms.join(" ")}` : term;
}

function buildPublicSearchTargets(keyword = "", {
  engines = PUBLIC_SEARCH_ENGINES,
  profiles = ["taiwan_zh_hant"],
  page = 0,
} = {}) {
  const activeEngines = (Array.isArray(engines) && engines.length ? engines : PUBLIC_SEARCH_ENGINES)
    .map(engine => String(engine || "").trim())
    .filter(engine => PUBLIC_SEARCH_ENGINES.includes(engine));
  const activeProfiles = normalizePublicSearchProfiles(profiles);
  const targets = [];
  for (const profile of activeProfiles) {
    const query = publicSearchProfileQuery(keyword, profile);
    if (!query) continue;
    if (activeEngines.includes("duckduckgo")) {
      const params = new URLSearchParams({
        q: query,
        kl: profile.duckduckgoKl || "wt-wt",
      });
      if (page > 0) params.set("s", String(page * 30));
      targets.push({
        engine: "duckduckgo",
        profile,
        query,
        page,
        url: `https://duckduckgo.com/html/?${params.toString()}`,
      });
    }
    if (page === 0 && activeEngines.includes("bing_rss")) {
      const params = new URLSearchParams({ q: query, format: "rss" });
      targets.push({
        engine: "bing_rss",
        profile,
        query,
        page,
        url: `https://www.bing.com/search?${params.toString()}`,
      });
    }
  }
  return targets;
}

function publicSearchMetrics(engine = "", profile = PUBLIC_SEARCH_PROFILES[0], query = "") {
  return {
    public_search_engine: engine,
    public_search_profile: profile?.key || "",
    public_search_region: profile?.region || "",
    public_search_language: profile?.language || "",
    public_search_query: query,
  };
}

function publicSearchDedupeKey(item = {}) {
  return normalizePublicSearchDedupeUrl(item?.url || "");
}

function publicSearchKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["public_search_query", metrics.public_search_query],
    ["gdelt_domain", metrics.gdelt_domain],
    ["gdelt_query_risk_terms", Array.isArray(metrics.gdelt_query_risk_terms) ? metrics.gdelt_query_risk_terms.join(" ") : metrics.gdelt_query_risk_terms],
    ["gdelt_timeline_top_articles", Array.isArray(metrics.gdelt_timeline_top_articles)
      ? metrics.gdelt_timeline_top_articles.map(article => `${article?.title || ""} ${article?.url || ""} ${article?.domain || ""}`).join(" ")
      : ""],
  ];
  const match = fields.find(([, value]) => publicSearchMatchesKeyword(value || "", keyword));
  return match ? match[0] : "";
}

function publicSearchKeywordDiagnostics(item = {}, keyword = "") {
  return {
    open_public_search_matched_keyword: String(keyword || "").trim().slice(0, 160),
    open_public_search_keyword_match_source: publicSearchKeywordMatchSource(item, keyword),
  };
}

function countDuckDuckGoRawResults(html = "") {
  return [...String(html || "").matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href=/gi)].length;
}

function countBingRssRawResults(xml = "") {
  return [...String(xml || "").matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].length;
}

function parseDuckDuckGoResults(html, keyword, limit = 10, { profile = PUBLIC_SEARCH_PROFILES[0], query = "" } = {}) {
  const source = String(html || "");
  const results = [];
  const blockRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const url = normalizeUrl(match[1]);
    const title = stripTags(match[2]);
    const content = stripTags((match[3].match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || match[3].match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || [])[1] || "");
    const candidate = { url, title, content, author: "DuckDuckGo 公開搜尋" };
    if (!url || !title || !publicSearchMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (!publicSearchProfileAllows(candidate, profile)) continue;
    results.push({
      url,
      title,
      content,
      author: "DuckDuckGo 公開搜尋",
      publishedAt: new Date().toISOString(),
      metrics: {
        ...publicSearchMetrics("duckduckgo", profile, query),
        public_search_canonical_dedupe_url: normalizePublicSearchDedupeUrl(url),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseBingRssResults(xml, keyword, limit = 10, { profile = PUBLIC_SEARCH_PROFILES[0], query = "" } = {}) {
  const source = String(xml || "");
  const blocks = [...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].map(match => match[0]);
  const results = [];
  for (const block of blocks) {
    const url = normalizeUrl(tagValue(block, "link"));
    const title = tagValue(block, "title");
    const content = tagValue(block, "description");
    const candidate = { url, title, content, author: "Bing RSS 公開搜尋" };
    if (!url || !title || !publicSearchMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (!publicSearchProfileAllows(candidate, profile)) continue;
    results.push({
      url,
      title,
      content,
      author: "Bing RSS 公開搜尋",
      publishedAt: normalizePublishedAt(tagValue(block, "pubDate")),
      metrics: {
        ...publicSearchMetrics("bing_rss", profile, query),
        public_search_canonical_dedupe_url: normalizePublicSearchDedupeUrl(url),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function gdeltDateToIso(value) {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return new Date().toISOString();
  return new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )).toISOString();
}

function gdeltProfileMatch(item = {}, profile = GDELT_QUERY_PROFILES[0]) {
  const terms = Array.isArray(profile?.terms) ? profile.terms : [];
  const text = `${item.title || ""} ${item.content || ""} ${item.url || ""} ${item.author || ""}`.toLowerCase();
  const hits = terms.filter(term => term && text.includes(String(term).toLowerCase()));
  let score = hits.length ? Math.min(55, 25 + hits.length * 15) : 0;
  const reasons = [];
  if (hits.length) reasons.push("gdelt-query-term-hit");
  if (profile?.region === "global" && publicSearchMatchesKeyword(text, item.keyword || "")) {
    score += 35;
    reasons.push("gdelt-global-keyword-hit");
  }
  const language = String(item.metrics?.gdelt_language || "").toLowerCase();
  const sourceCountry = String(item.metrics?.gdelt_source_country || "").toUpperCase();
  if (profile?.language && language && String(profile.language).toLowerCase().startsWith(language.slice(0, 2))) {
    score += 15;
    reasons.push("gdelt-language-aligned");
  }
  const expectedCountries = GDELT_PROFILE_COUNTRY_HINTS.get(profile?.region) || [];
  if (expectedCountries.includes(sourceCountry)) {
    score += 18;
    reasons.push("gdelt-source-country-aligned");
  }
  if (profile?.region === "global" && hits.length) {
    score += 6;
    reasons.push("gdelt-global-profile-keyword-context");
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    hits,
    reasons,
  };
}

function gdeltProfileRegionAllows(item = {}, profile = GDELT_QUERY_PROFILES[0]) {
  if (profile?.region === "global") return true;
  const sourceCountry = String(item.metrics?.gdelt_source_country || "").toUpperCase();
  const expectedCountries = GDELT_PROFILE_COUNTRY_HINTS.get(profile?.region) || [];
  if (sourceCountry && expectedCountries.includes(sourceCountry)) return true;
  const terms = Array.isArray(profile?.terms) ? profile.terms : [];
  const text = `${item.title || ""} ${item.content || ""} ${item.url || ""} ${item.author || ""}`.toLowerCase();
  if (terms.some(term => term && text.includes(String(term).toLowerCase()))) return true;
  if (profile?.region === "taiwan") return isTaiwanRelatedText(item.title, item.content, item.url, item.author);
  return false;
}

function matchedGdeltTerms(text = "", terms = [], limit = 10) {
  const lower = String(text || "").toLowerCase();
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    if (!raw) continue;
    if (lower.includes(raw.toLowerCase()) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeGdeltThemes(value = []) {
  const rows = Array.isArray(value) ? value : String(value || "").split(/[;,|]/);
  return rows.map(item => stripTags(item).trim()).filter(Boolean).slice(0, 30);
}

function gdeltDomainTier(domain = "") {
  const host = String(domain || "").toLowerCase();
  if (!host) return "";
  if (/(reuters|apnews|associatedpress|bloomberg|dowjones|afp|pa\.media|prnewswire|businesswire)\./i.test(host)) return "wire-or-financial-news";
  if (/(bbc|cnn|nytimes|washingtonpost|wsj|theguardian|ft\.com|nikkei|scmp|straitstimes|cna|channelnewsasia|rfi|dw|lemonde|elpais|asahi|yomiuri|chosun|joongang|koreaherald|thehindu|timesofindia)/i.test(host)) return "major-news-outlet";
  if (/news|daily|times|post|press|journal|media|tribune|herald|報|新闻|新聞|日報|日报/i.test(host)) return "news-domain";
  return "other-domain";
}

function gdeltArticleCoverageBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function gdeltArticleCoverageSignals({
  title = "",
  content = "",
  domain = "",
  sourceCountry = "",
  language = "",
  profile = GDELT_QUERY_PROFILES[0],
  riskTerms = [],
  queryMode = "base",
  themes = [],
  socialImage = "",
  tone = 0,
} = {}) {
  const normalizedThemes = normalizeGdeltThemes(themes);
  const text = `${title} ${content} ${domain} ${sourceCountry} ${language} ${normalizedThemes.join(" ")}`.toLowerCase();
  const riskNarrativeTerms = matchedGdeltTerms(text, [
    "complaint", "refund", "dispute", "scam", "fraud", "lawsuit", "investigation", "recall", "outage", "breach", "boycott",
    "投訴", "投诉", "退款", "詐騙", "诈骗", "訴訟", "诉讼", "調查", "调查", "召回", "外洩", "泄露", "抵制",
  ]);
  const officialResponseTerms = matchedGdeltTerms(text, [
    "statement", "response", "apology", "announced", "notice", "press release", "regulator", "official",
    "聲明", "声明", "回應", "回应", "道歉", "公告", "監管", "监管", "官方",
  ]);
  const propagationTerms = matchedGdeltTerms(text, [
    "viral", "spreading", "coverage", "media", "international", "global", "cross-border", "social media", "trending",
    "擴散", "扩散", "熱議", "热议", "媒體", "媒体", "跨境", "全球", "國際", "国际",
  ]);
  const gdeltThemeTerms = matchedGdeltTerms(normalizedThemes.join(" "), [
    "crisis", "protest", "boycott", "lawsuit", "crime", "corruption", "cyber", "data", "privacy", "recall", "safety", "fraud",
  ]);
  const country = String(sourceCountry || "").toUpperCase();
  const expectedCountries = GDELT_PROFILE_COUNTRY_HINTS.get(profile?.region) || [];
  const sourceCountrySignal = Boolean(country);
  const crossRegion = sourceCountrySignal && profile?.region && profile.region !== "global" && !expectedCountries.includes(country);
  const domainTier = gdeltDomainTier(domain);
  const majorDomain = domainTier === "wire-or-financial-news" || domainTier === "major-news-outlet";
  const negativeTone = Number(tone || 0) <= -2;
  const riskIntent = queryMode !== "base" || (Array.isArray(riskTerms) && riskTerms.length > 0);
  const multimedia = Boolean(socialImage);
  const reasons = [];
  if (riskNarrativeTerms.length) reasons.push("risk-narrative-language");
  if (officialResponseTerms.length) reasons.push("official-response-language");
  if (propagationTerms.length) reasons.push("propagation-language");
  if (gdeltThemeTerms.length) reasons.push("gdelt-risk-theme");
  if (sourceCountrySignal) reasons.push("source-country-observed");
  if (crossRegion) reasons.push("cross-region-media-hit");
  if (majorDomain) reasons.push("major-or-wire-source");
  if (negativeTone) reasons.push("negative-article-tone");
  if (riskIntent) reasons.push("risk-intent-article-query");
  if (multimedia) reasons.push("article-media-evidence");
  const semanticSignalCount = [
    riskNarrativeTerms.length,
    officialResponseTerms.length,
    propagationTerms.length || crossRegion || majorDomain,
    gdeltThemeTerms.length || negativeTone || riskIntent,
    sourceCountrySignal || multimedia,
  ].filter(Boolean).length;
  const completeCrisisNarrative = semanticSignalCount >= 5;
  if (completeCrisisNarrative) reasons.push("gdelt-article-complete-crisis-narrative");
  const score = Math.min(100, Math.max(0,
    (riskNarrativeTerms.length ? 18 : 0)
    + (officialResponseTerms.length ? 10 : 0)
    + (propagationTerms.length ? 12 : 0)
    + (gdeltThemeTerms.length ? 12 : 0)
    + (sourceCountrySignal ? 6 : 0)
    + (crossRegion ? 12 : 0)
    + (majorDomain ? 12 : domainTier === "news-domain" ? 8 : 0)
    + (negativeTone ? 10 : 0)
    + (riskIntent ? 12 : 0)
    + (multimedia ? 6 : 0)
  ));
  return {
    gdelt_article_risk_narrative_signal: riskNarrativeTerms.length ? 1 : 0,
    gdelt_article_official_response_signal: officialResponseTerms.length ? 1 : 0,
    gdelt_article_propagation_signal: propagationTerms.length ? 1 : 0,
    gdelt_article_theme_risk_signal: gdeltThemeTerms.length ? 1 : 0,
    gdelt_article_source_country_signal: sourceCountrySignal ? 1 : 0,
    gdelt_article_cross_region_signal: crossRegion ? 1 : 0,
    gdelt_article_major_source_signal: majorDomain ? 1 : 0,
    gdelt_article_negative_tone_signal: negativeTone ? 1 : 0,
    gdelt_article_risk_intent_signal: riskIntent ? 1 : 0,
    gdelt_article_media_signal: multimedia ? 1 : 0,
    gdelt_article_domain_tier: domainTier,
    gdelt_article_risk_terms: riskNarrativeTerms,
    gdelt_article_response_terms: officialResponseTerms,
    gdelt_article_propagation_terms: propagationTerms,
    gdelt_article_theme_terms: gdeltThemeTerms,
    gdelt_article_themes: normalizedThemes,
    gdelt_article_semantic_signal_count: semanticSignalCount,
    gdelt_article_complete_crisis_narrative_signal: completeCrisisNarrative ? 1 : 0,
    gdelt_article_coverage_score: score,
    gdelt_article_coverage_bucket: gdeltArticleCoverageBucket(score),
    gdelt_article_coverage_signal_count: reasons.length,
    gdelt_article_coverage_reasons: reasons,
  };
}

function parseGdeltArticles(payload, keyword, limit = 10, since = "", { profile = GDELT_QUERY_PROFILES[0], queryMode = "base", riskTerms = [] } = {}) {
  const articles = Array.isArray(payload?.articles) ? payload.articles : [];
  return articles.map(article => {
    const title = stripTags(article.title || "");
    const content = stripTags(article.seendescription || article.socialimage || article.domain || "");
    const domain = stripTags(article.domain || "");
    const sourceCountry = stripTags(article.sourcecountry || "");
    const language = stripTags(article.language || "");
    const themes = normalizeGdeltThemes(article.themes || article.theme || article.tags || []);
    const socialImage = normalizeUrl(article.socialimage || "");
    const tone = Number(article.tone ?? article.avgtone ?? article.avgTone ?? 0);
    const coverageSignals = gdeltArticleCoverageSignals({
      title,
      content,
      domain,
      sourceCountry,
      language,
      profile,
      riskTerms,
      queryMode,
      themes,
      socialImage,
      tone: Number.isFinite(tone) ? tone : 0,
    });
    const item = {
      url: normalizeUrl(article.url || ""),
      title,
      content,
      author: domain || "GDELT",
      publishedAt: gdeltDateToIso(article.seendate),
      keyword,
      metrics: {
        ...(language ? { gdelt_language: language } : {}),
        ...(sourceCountry ? { gdelt_source_country: sourceCountry } : {}),
        ...(domain ? { gdelt_domain: domain } : {}),
        ...(socialImage ? { gdelt_social_image: socialImage } : {}),
        ...(Number.isFinite(tone) ? { gdelt_article_tone: tone } : {}),
        gdelt_canonical_dedupe_url: normalizePublicSearchDedupeUrl(article.url || ""),
        ...coverageSignals,
      },
    };
    const profileMatch = gdeltProfileMatch(item, profile);
    return {
      ...item,
      metrics: {
        ...(item.metrics || {}),
        gdelt_profile_match_score: profileMatch.score,
        gdelt_profile_match_terms: profileMatch.hits,
        gdelt_profile_match_reasons: profileMatch.reasons,
      },
    };
  }).filter(item => (
    item.url
    && item.title
    && publicSearchMatchesKeyword(`${item.title} ${item.content}`, keyword)
    && isRecentDate(item.publishedAt)
    && isAfterSince(item.publishedAt, since)
    && gdeltProfileRegionAllows(item, profile)
    && Number(item.metrics?.gdelt_profile_match_score || 0) >= 25
  )).slice(0, limit);
}

function normalizeGdeltProfiles(profiles = GDELT_QUERY_PROFILES.map(profile => profile.key)) {
  const wanted = Array.isArray(profiles) && profiles.length ? profiles : GDELT_QUERY_PROFILES.map(profile => profile.key);
  const keys = new Set(wanted.map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  const out = GDELT_QUERY_PROFILES.filter(profile => keys.has(profile.key.toLowerCase()));
  return out.length ? out : GDELT_QUERY_PROFILES;
}

function gdeltQueryPlans(keyword = "", deepBudget = { riskQueryExpansion: false }) {
  const term = String(keyword || "").trim();
  if (!term) return [];
  const normalizedDeepBudget = normalizeGdeltDeepBudget(deepBudget);
  const plans = [{
    queryKeyword: term,
    queryMode: "base",
    queryTemplateKey: "base",
    riskTerms: [],
  }];
  if (!normalizedDeepBudget.riskQueryExpansion || normalizedDeepBudget.maxRiskQueriesPerKeyword <= 0) return plans;
  for (const template of GDELT_RISK_QUERY_TEMPLATES.slice(0, normalizedDeepBudget.maxRiskQueriesPerKeyword)) {
    plans.push({
      queryKeyword: `${term} (${template.terms.join(" OR ")})`,
      queryMode: "risk_intent",
      queryTemplateKey: template.key,
      riskTerms: template.terms,
    });
  }
  return plans;
}

function buildGdeltQueries(keyword = "", profiles = GDELT_QUERY_PROFILES.map(profile => profile.key), deepBudget = { riskQueryExpansion: false }) {
  const plans = gdeltQueryPlans(keyword, deepBudget);
  if (!plans.length) return [];
  return plans.flatMap(plan => normalizeGdeltProfiles(profiles).map(profile => {
    const terms = (profile.terms || []).filter(Boolean);
    const query = terms.length ? `${plan.queryKeyword} (${terms.join(" OR ")})` : plan.queryKeyword;
    return {
      profile,
      queryMode: plan.queryMode,
      queryTemplateKey: plan.queryTemplateKey,
      riskTerms: plan.riskTerms,
      query,
      url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&format=json&sort=hybridrel&timespan=3d`,
    };
  }));
}

function buildGdeltTimelineQueries(keyword = "", profiles = GDELT_QUERY_PROFILES.map(profile => profile.key), deepBudget = { riskQueryExpansion: false }) {
  return buildGdeltQueries(keyword, profiles, deepBudget).map(target => ({
    ...target,
    url: target.url.replace("mode=ArtList", "mode=TimelineVolInfo").replace("sort=hybridrel&", ""),
  }));
}

function gdeltTimelineDateToIso(value = "") {
  const raw = String(value || "").trim();
  if (/^\d{14}$/.test(raw)) return gdeltDateToIso(raw);
  if (/^\d{8}$/.test(raw)) return gdeltDateToIso(`${raw}000000`);
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function parseGdeltTimelineTopArticles(value = []) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map(row => ({
    title: stripTags(row.title || row.name || ""),
    url: normalizeUrl(row.url || ""),
    domain: stripTags(row.domain || ""),
    source_country: stripTags(row.sourcecountry || row.sourceCountry || ""),
    language: stripTags(row.language || ""),
  })).filter(row => row.title || row.url).slice(0, 10);
}

function gdeltTimelineCoverageBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function gdeltTimelineCoverageSignals({
  points = [],
  peak = {},
  averageVolume = 0,
  averageTone = 0,
  topArticles = [],
  queryMode = "base",
  riskTerms = [],
} = {}) {
  const peakVolume = Math.max(0, Number(peak?.volume || 0));
  const avgVolume = Math.max(0, Number(averageVolume || 0));
  const avgTone = Number(averageTone || 0);
  const normalizedArticles = Array.isArray(topArticles) ? topArticles : [];
  const sourceDomains = [...new Set(normalizedArticles
    .map(article => String(article?.domain || "").trim().toLowerCase())
    .filter(Boolean))];
  const ratio = avgVolume > 0 ? peakVolume / avgVolume : (peakVolume > 0 ? peakVolume : 0);
  const reasons = [];
  if (peakVolume >= 8) reasons.push("high-coverage-peak");
  else if (peakVolume >= 4) reasons.push("elevated-coverage-peak");
  if (ratio >= 2) reasons.push("coverage-spike-over-baseline");
  if (avgTone <= -3) reasons.push("strong-negative-tone");
  else if (avgTone <= -1) reasons.push("negative-tone");
  if (queryMode !== "base" || (Array.isArray(riskTerms) && riskTerms.length > 0)) reasons.push("risk-intent-timeline-query");
  if (normalizedArticles.length >= 3) reasons.push("multiple-peak-articles");
  else if (normalizedArticles.length > 0) reasons.push("peak-article-evidence");
  if (sourceDomains.length >= 2) reasons.push("multi-domain-coverage");
  if (Array.isArray(points) && points.length >= 2) reasons.push("multi-point-timeline");

  const score = Math.min(100, Math.max(0,
    Math.min(30, Math.round(peakVolume * 4))
    + (ratio >= 2 ? 18 : ratio >= 1.5 ? 8 : 0)
    + (avgTone <= -3 ? 16 : avgTone <= -1 ? 8 : 0)
    + (queryMode !== "base" || (Array.isArray(riskTerms) && riskTerms.length > 0) ? 18 : 0)
    + Math.min(10, normalizedArticles.length * 3)
    + Math.min(8, sourceDomains.length * 4)
    + (Array.isArray(points) && points.length >= 2 ? 6 : 0)
  ));

  return {
    gdelt_timeline_peak_to_average_ratio: Number(ratio.toFixed(4)),
    gdelt_timeline_negative_tone_signal: avgTone <= -1 ? 1 : 0,
    gdelt_timeline_risk_intent_signal: queryMode !== "base" || (Array.isArray(riskTerms) && riskTerms.length > 0) ? 1 : 0,
    gdelt_timeline_top_article_count: normalizedArticles.length,
    gdelt_timeline_source_domain_count: sourceDomains.length,
    gdelt_timeline_coverage_score: score,
    gdelt_timeline_coverage_bucket: gdeltTimelineCoverageBucket(score),
    gdelt_timeline_coverage_signal_count: reasons.length,
    gdelt_timeline_coverage_reasons: reasons,
  };
}

function parseGdeltTimelineResults(payload = {}, keyword = "", {
  profile = GDELT_QUERY_PROFILES[0],
  limit = 1,
  since = "",
  queryUrl = "",
  queryMode = "base",
  queryTemplateKey = "base",
  riskTerms = [],
} = {}) {
  const rows = Array.isArray(payload?.timeline)
    ? payload.timeline
    : Array.isArray(payload?.timelinevol)
      ? payload.timelinevol
      : Array.isArray(payload?.timelinevolraw)
        ? payload.timelinevolraw
        : [];
  const points = rows.map(row => {
    const date = gdeltTimelineDateToIso(row.date || row.datetime || row.timestamp || row.time);
    const volume = Number(row.value ?? row.volume ?? row.count ?? row.norm ?? 0);
    const tone = Number(row.tone ?? row.avgtone ?? row.avgTone ?? 0);
    return {
      date,
      volume: Number.isFinite(volume) ? volume : 0,
      tone: Number.isFinite(tone) ? tone : 0,
      top_articles: parseGdeltTimelineTopArticles(row.toparts || row.toparticles || row.articles || []),
    };
  }).filter(point => point.date && isAfterSince(point.date, since));
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => b.volume - a.volume);
  const peak = sorted[0];
  const averageVolume = points.reduce((sum, point) => sum + point.volume, 0) / points.length;
  const averageTone = points.reduce((sum, point) => sum + point.tone, 0) / points.length;
  const topArticles = sorted.flatMap(point => point.top_articles || []).slice(0, 10);
  const terms = Array.isArray(profile?.terms) ? profile.terms : [];
  const queryDetails = payload?.query_details || {};
  const normalizedRiskTerms = Array.isArray(riskTerms) ? riskTerms.filter(Boolean) : [];
  const coverageSignals = gdeltTimelineCoverageSignals({
    points,
    peak,
    averageVolume,
    averageTone,
    topArticles,
    queryMode,
    riskTerms: normalizedRiskTerms,
  });
  return [{
    url: queryUrl || `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${keyword} ${terms.join(" ")}`)}&mode=TimelineVolInfo`,
    title: `GDELT coverage timeline: ${keyword}`,
    content: [
      `GDELT timeline for ${keyword}.`,
      `Profile: ${profile?.key || "global"}.`,
      queryMode !== "base" ? `Query intent: ${queryTemplateKey}.` : "",
      `Timeline points: ${points.length}.`,
      `Peak date: ${peak.date}.`,
      `Peak volume: ${peak.volume}.`,
      `Average volume: ${averageVolume.toFixed(2)}.`,
      Number.isFinite(averageTone) ? `Average tone: ${averageTone.toFixed(2)}.` : "",
      `Coverage bucket: ${coverageSignals.gdelt_timeline_coverage_bucket}.`,
      normalizedRiskTerms.length ? `Risk terms: ${normalizedRiskTerms.join(", ")}.` : "",
      topArticles.length ? `Peak related articles: ${topArticles.map(article => article.title || article.url).filter(Boolean).join("; ")}.` : "",
    ].filter(Boolean).join(" "),
    author: "GDELT Project",
    publishedAt: peak.date,
    keyword,
    skipEnrich: true,
    metrics: {
      source: "gdelt_timeline_volinfo",
      source_family: "news",
      source_kind: "global_news_coverage_timeline",
      collection_mode: "gdelt_doc_timeline_volinfo_json",
      gdelt_query_profile: profile?.key || "",
      gdelt_query_region: profile?.region || "",
      gdelt_query_language: profile?.language || "",
      gdelt_query_mode: queryMode,
      gdelt_query_template_key: queryTemplateKey,
      gdelt_query_risk_terms: normalizedRiskTerms,
      gdelt_timeline_points: points.length,
      gdelt_timeline_peak_date: peak.date,
      gdelt_timeline_peak_volume: peak.volume,
      gdelt_timeline_average_volume: Number(averageVolume.toFixed(4)),
      gdelt_timeline_average_tone: Number(averageTone.toFixed(4)),
      gdelt_timeline_top_articles: topArticles,
      gdelt_timeline_query_details: queryDetails,
      ...coverageSignals,
      source_weight_tier: "global-news-coverage-timeline",
    },
  }].slice(0, Math.max(1, Math.min(3, Number(limit) || 1)));
}

function evidenceWithFailover(evidence = {}, failoverAttribution = [], itemMetrics = {}) {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  if (!attribution.length && !Object.keys(itemMetrics || {}).length) return evidence || {};
  return {
    ...(evidence || {}),
    metrics: {
      ...(evidence?.metrics || {}),
      ...(itemMetrics || {}),
      failover_attribution: attribution,
      failover_from_sources: [...new Set(attribution.map(item => item?.fromSource).filter(Boolean))],
    },
  };
}

async function insertPublicItems(items, { platform, keyword, proxyUrl, enrich = true, domainControls = {}, contentControls = {}, failoverAttribution = [], seenItemUrls = null }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = publicSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const fallback = item.content || "";
    const shouldEnrich = enrich && !item.skipEnrich;
    const enriched = shouldEnrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: fallback, ai_summary: fallback, enriched: false };
    const content = enriched.content || item.content || "";
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform,
      url: item.url,
      title: item.title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
      keyword,
      keywords: [keyword],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary,
      raw_html: enriched.raw_html || "",
      evidence: evidenceWithFailover(enriched.evidence || {}, failoverAttribution, {
        ...(item.metrics || {}),
        ...publicSearchKeywordDiagnostics({
          ...item,
          content,
          author: enriched.author || item.author,
        }, keyword),
        open_public_search_scan_dedupe_key: dedupeKey,
      }),
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      domainControls,
      contentControls,
      failoverAttribution,
    });
    if (result.inserted) inserted++;
  }
  return inserted;
}

export async function scrapeDuckDuckGo(keywords, {
  proxyUrl = "",
  enrich = true,
  budget = {},
  searchEngines = PUBLIC_SEARCH_ENGINES,
  publicSearchProfiles = undefined,
  searchProfiles = undefined,
  domainControls = {},
  contentControls = {},
  failoverAttribution = [],
} = {}) {
  if (!keywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const engines = (Array.isArray(searchEngines) && searchEngines.length ? searchEngines : PUBLIC_SEARCH_ENGINES)
    .map(engine => String(engine || "").trim())
    .filter(engine => PUBLIC_SEARCH_ENGINES.includes(engine));
  const profiles = normalizePublicSearchProfiles(publicSearchProfiles || searchProfiles || ["taiwan_zh_hant"]);
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(keywords, KEYWORD_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const items = [];
      const seenUrls = new Set();
      for (let page = 0; page < normalizedBudget.maxPagesPerKeyword && items.length < normalizedBudget.maxItemsPerKeyword; page += 1) {
        let pageFound = 0;
        let rawPageFound = 0;
        for (const target of buildPublicSearchTargets(keyword, { engines, profiles: profiles.map(profile => profile.key), page })) {
          if (target.engine === "duckduckgo") {
            const res = await fetchPublicSource(target.url, {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept-Language": target.profile.acceptLanguage || "en-US,en;q=0.9",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!res.ok) {
              failures.push({ keyword, target: `page:${page + 1}:${target.profile.key}`, engine: "duckduckgo", message: httpFailure(res) });
            } else {
              const html = await res.text();
              const rawCount = countDuckDuckGoRawResults(html);
              rawPageFound += rawCount;
              const pageItems = parseDuckDuckGoResults(
                html,
                keyword,
                normalizedBudget.maxItemsPerKeyword - items.length,
                { profile: target.profile, query: target.query },
              );
              for (const item of pageItems) {
                const normalized = publicSearchDedupeKey(item);
                if (!normalized || seenUrls.has(normalized)) continue;
                seenUrls.add(normalized);
                items.push({
                  ...item,
                  metrics: {
                    ...(item.metrics || {}),
                    public_search_page: page + 1,
                    public_search_raw_result_count: rawCount,
                  },
                });
                pageFound += 1;
              }
            }
          }
          if (target.engine === "bing_rss" && items.length < normalizedBudget.maxItemsPerKeyword) {
            const res = await fetchPublicSource(target.url, {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
                "Accept-Language": target.profile.acceptLanguage || "en-US,en;q=0.9",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!res.ok) {
              failures.push({ keyword, target: `bing:rss:${target.profile.key}`, engine: "bing_rss", message: httpFailure(res) });
            } else {
              const xml = await res.text();
              const rawCount = countBingRssRawResults(xml);
              rawPageFound += rawCount;
              const pageItems = parseBingRssResults(
                xml,
                keyword,
                normalizedBudget.maxItemsPerKeyword - items.length,
                { profile: target.profile, query: target.query },
              );
              for (const item of pageItems) {
                const normalized = publicSearchDedupeKey(item);
                if (!normalized || seenUrls.has(normalized)) continue;
                seenUrls.add(normalized);
                items.push({
                  ...item,
                  metrics: {
                    ...(item.metrics || {}),
                    public_search_page: page + 1,
                    public_search_raw_result_count: rawCount,
                  },
                });
                pageFound += 1;
              }
            }
          }
          if (items.length >= normalizedBudget.maxItemsPerKeyword) break;
        }
        if (!pageFound && !rawPageFound) break;
      }
      inserted += await insertPublicItems(items, { platform: "duckduckgo", keyword, proxyUrl, enrich, domainControls, contentControls, failoverAttribution, seenItemUrls });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/DuckDuckGo] 爬取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeGdelt(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = {}, since = "", gdeltProfiles = undefined, domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  if (!keywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeGdeltDeepBudget(deepBudget);
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(keywords, KEYWORD_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const items = [];
      const seenUrls = new Set();
      for (const queryTarget of buildGdeltQueries(keyword, gdeltProfiles, normalizedDeepBudget)) {
        const url = `${queryTarget.url}&maxrecords=${normalizedBudget.maxItemsPerKeyword}`;
        const res = await fetchPublicSource(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, profile: queryTarget.profile.key, message: httpFailure(res) });
          continue;
        }
        const payload = await res.json();
        const pageItems = parseGdeltArticles(payload, keyword, normalizedBudget.maxItemsPerKeyword - items.length, since, {
          profile: queryTarget.profile,
          queryMode: queryTarget.queryMode,
          riskTerms: queryTarget.riskTerms,
        });
        for (const item of pageItems) {
          const normalized = publicSearchDedupeKey(item);
          if (!normalized || seenUrls.has(normalized)) continue;
          seenUrls.add(normalized);
          items.push({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              gdelt_query_profile: queryTarget.profile.key,
              gdelt_query_region: queryTarget.profile.region,
              gdelt_query_language: queryTarget.profile.language,
              gdelt_query_mode: queryTarget.queryMode,
              gdelt_query_template_key: queryTarget.queryTemplateKey,
              gdelt_query_risk_terms: queryTarget.riskTerms,
            },
          });
          if (items.length >= normalizedBudget.maxItemsPerKeyword) break;
        }
        if (items.length >= normalizedBudget.maxItemsPerKeyword) break;
      }
      const timelineItems = [];
      if (normalizedDeepBudget.maxTimelineQueriesPerKeyword > 0 && items.length < normalizedBudget.maxItemsPerKeyword) {
        const remaining = normalizedBudget.maxItemsPerKeyword - items.length;
        const timelineTargets = buildGdeltTimelineQueries(keyword, gdeltProfiles, normalizedDeepBudget).slice(0, normalizedDeepBudget.maxTimelineQueriesPerKeyword);
        for (const queryTarget of timelineTargets) {
          const res = await fetchPublicSource(queryTarget.url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, profile: queryTarget.profile.key, mode: "timeline", message: httpFailure(res) });
            continue;
          }
          const timelinePayload = await res.json();
          const parsedTimeline = parseGdeltTimelineResults(timelinePayload, keyword, {
            profile: queryTarget.profile,
            limit: remaining - timelineItems.length,
            since,
            queryUrl: queryTarget.url,
            queryMode: queryTarget.queryMode,
            queryTemplateKey: queryTarget.queryTemplateKey,
            riskTerms: queryTarget.riskTerms,
          });
          for (const item of parsedTimeline) {
            const normalized = normalizeUrl(item.url);
            if (!normalized || seenUrls.has(normalized)) continue;
            seenUrls.add(normalized);
            timelineItems.push(item);
            if (timelineItems.length >= remaining) break;
          }
          if (timelineItems.length >= remaining) break;
        }
      }
      items.push(...timelineItems);
      inserted += await insertPublicItems(items, { platform: "gdelt", keyword, proxyUrl, enrich, domainControls, contentControls, failoverAttribution, seenItemUrls });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/GDELT] 爬取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  PUBLIC_SEARCH_PROFILES,
  normalizePublicSearchProfiles,
  buildPublicSearchTargets,
  normalizePublicSearchDedupeUrl,
  publicSearchDedupeKey,
  publicSearchKeywordMatchSource,
  publicSearchKeywordDiagnostics,
  GDELT_QUERY_PROFILES,
  GDELT_PROFILE_COUNTRY_HINTS,
  GDELT_RISK_QUERY_TEMPLATES,
  gdeltQueryPlans,
  buildGdeltQueries,
  buildGdeltTimelineQueries,
  normalizeGdeltProfiles,
  normalizeGdeltDeepBudget,
  parseBingRssResults,
  parseDuckDuckGoResults,
  countBingRssRawResults,
  countDuckDuckGoRawResults,
  parseGdeltArticles,
  gdeltArticleCoverageBucket,
  gdeltArticleCoverageSignals,
  gdeltTimelineCoverageBucket,
  gdeltTimelineCoverageSignals,
  compactKeywordText,
  publicSearchMatchesKeyword,
  parseGdeltTimelineResults,
  normalizeBudget,
};
