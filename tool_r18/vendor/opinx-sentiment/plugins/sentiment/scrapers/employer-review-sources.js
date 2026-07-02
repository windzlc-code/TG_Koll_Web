import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_TARGET = 4;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 8;
const DEFAULT_MAX_PAGES_PER_TARGET = 3;

export const EMPLOYER_REVIEW_TARGETS = [
  {
    key: "glassdoor",
    name: "Glassdoor Reviews",
    siteQuery: "site:glassdoor.com/Reviews",
    hostPattern: /(^|\.)glassdoor\.com$/i,
    tags: ["employer", "employee-review", "workplace", "culture", "layoffs"],
    profiles: ["global", "employer", "workplace", "review"],
    tier: "employer-review",
  },
  {
    key: "indeed",
    name: "Indeed Company Reviews",
    siteQuery: "site:indeed.com/cmp",
    hostPattern: /(^|\.)indeed\.com$/i,
    tags: ["employer", "employee-review", "workplace", "rating"],
    profiles: ["global", "employer", "workplace", "review"],
    tier: "employer-review",
  },
  {
    key: "kununu",
    name: "Kununu",
    siteQuery: "site:kununu.com",
    hostPattern: /(^|\.)kununu\.com$/i,
    tags: ["employer", "employee-review", "workplace", "europe"],
    profiles: ["europe", "employer", "workplace", "review"],
    tier: "employer-review",
  },
  {
    key: "comparably",
    name: "Comparably Companies",
    siteQuery: "site:comparably.com/companies",
    hostPattern: /(^|\.)comparably\.com$/i,
    tags: ["employer", "culture", "leadership", "employee-review"],
    profiles: ["us", "employer", "workplace", "review"],
    tier: "employer-review",
  },
  {
    key: "ambitionbox",
    name: "AmbitionBox Reviews",
    siteQuery: "site:ambitionbox.com/reviews",
    hostPattern: /(^|\.)ambitionbox\.com$/i,
    tags: ["employer", "employee-review", "workplace", "india"],
    profiles: ["india", "employer", "workplace", "review"],
    tier: "employer-review",
  },
  {
    key: "teamblind",
    name: "Blind Company Discussions",
    siteQuery: "site:teamblind.com/company",
    hostPattern: /(^|\.)teamblind\.com$/i,
    tags: ["employee-discussion", "workplace", "layoffs", "culture"],
    profiles: ["us", "employer", "workplace", "discussion"],
    tier: "employee-community",
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
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeEmployerReviewDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeEmployerReviewDedupeUrl(embedded);
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
    url.hostname = url.hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return String(normalized || "").toLowerCase();
  }
}

function employerReviewDedupeKey(item = {}) {
  return normalizeEmployerReviewDedupeUrl(item?.url || "");
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
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(EMPLOYER_REVIEW_TARGETS.length, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
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
  const values = new Set([
    ...(target.profiles || []),
    ...(target.tags || []),
    target.tier,
    target.key,
    target.name,
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  return profiles.some(profile => values.has(profile));
}

function normalizeTargets(targets = [], targetProfiles = []) {
  const configured = Array.isArray(targets) ? targets.map(item => String(item || "").trim()).filter(Boolean) : [];
  const candidates = EMPLOYER_REVIEW_TARGETS.filter(target => targetMatchesProfiles(target, targetProfiles));
  if (!configured.length) return candidates.length ? candidates : EMPLOYER_REVIEW_TARGETS;
  const wanted = new Set(configured.map(item => item.toLowerCase()));
  const selected = candidates.filter(target => wanted.has(target.key.toLowerCase()) || wanted.has(target.name.toLowerCase()));
  return selected.length ? selected : (candidates.length ? candidates : EMPLOYER_REVIEW_TARGETS);
}

function normalizeDirectUrls(directUrls = []) {
  const raw = Array.isArray(directUrls)
    ? directUrls
    : typeof directUrls === "string"
      ? directUrls.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeUrl(value);
    const dedupe = normalizeEmployerReviewDedupeUrl(normalized);
    if (!normalized || !dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
  }
  return out;
}

function hostMatches(url, pattern) {
  try {
    return pattern.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isConcreteEmployerReviewUrl(url = "", target = {}) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (!hostMatches(url, target.hostPattern)) return false;
    if (target.key === "glassdoor") return /\/(?:reviews|overview|salary|interviews)\//i.test(path) || /-reviews-/i.test(path);
    if (target.key === "indeed") return path.includes("/cmp/") && /reviews|salaries|jobs|about/i.test(path);
    if (target.key === "kununu") return path.includes("/bewertungen") || path.includes("/reviews") || path.split("/").filter(Boolean).length >= 2;
    if (target.key === "comparably") return path.includes("/companies/");
    if (target.key === "ambitionbox") return path.includes("/reviews") || path.includes("/overview") || path.includes("/salaries");
    if (target.key === "teamblind") return path.includes("/company/") || path.includes("/post/");
    return true;
  } catch {
    return false;
  }
}

function directEmployerReviewTargets(directUrls = [], selectedTargets = []) {
  const targets = Array.isArray(selectedTargets) && selectedTargets.length ? selectedTargets : EMPLOYER_REVIEW_TARGETS;
  const out = [];
  const seen = new Set();
  for (const url of normalizeDirectUrls(directUrls)) {
    for (const target of targets) {
      if (!isConcreteEmployerReviewUrl(url, target)) continue;
      const dedupe = `${target.key}|${normalizeEmployerReviewDedupeUrl(url)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ url, target });
      break;
    }
  }
  return out;
}

function directEmployerReviewItem(url = "", keyword = "", target = {}) {
  const cleanedUrl = normalizeUrl(url);
  if (!cleanedUrl || !isConcreteEmployerReviewUrl(cleanedUrl, target)) return null;
  let title = `${keyword || ""} ${target.name || "employer review"}`.replace(/\s+/g, " ").trim();
  try {
    const parsed = new URL(cleanedUrl);
    const slug = decodeURIComponent(parsed.pathname || "")
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join(" ")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (slug) title = `${keyword || ""} ${target.name || ""} ${slug}`.replace(/\s+/g, " ").trim();
  } catch {
    // Keep fallback title.
  }
  return {
    url: cleanedUrl,
    title,
    content: "",
    author: target.name,
    publishedAt: new Date().toISOString(),
    targetKey: target.key,
    targetName: target.name,
    targetTags: target.tags,
    directUrl: true,
    matchedKeyword: keyword,
    searchPage: 0,
    searchRawResultCount: 1,
  };
}

function normalizeEmployerReviewKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function employerReviewKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeEmployerReviewKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function employerReviewValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeEmployerReviewKeywordText(value);
  return employerReviewKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeEmployerReviewKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function parseEmployerReviewSearchResults(html, keyword, target, limit = DEFAULT_MAX_ITEMS_PER_TARGET) {
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
    if (!employerReviewValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
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

function employerReviewKeywordMatchSource(item = {}, keyword = "", target = {}) {
  if (!employerReviewKeywordNeedles(keyword).length) return "";
  if (employerReviewValueMatchesKeyword(item.title, keyword)) return "title";
  if (employerReviewValueMatchesKeyword(item.content, keyword)) return "snippet";
  if (employerReviewValueMatchesKeyword(item.url, keyword)) return "url";
  const targetText = [
    target.name,
    target.key,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  if (employerReviewValueMatchesKeyword(targetText, keyword)) return "target_metadata";
  return "search_query";
}

function employerReviewTermMatches(text = "", terms = []) {
  const source = normalizeEmployerReviewKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeEmployerReviewKeywordText(term);
    return needle && source.includes(needle);
  });
}

function employerWorkplaceRiskSignals({ item = {}, target = {}, content = "", metrics = {} } = {}) {
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
  const reasons = [];
  let score = /employer|workplace|employee/i.test(targetText) ? 16 : 10;
  const out = {};
  const evidenceTerms = employerReviewTermMatches(text, [
    "screenshot", "email", "slack", "teams message", "internal memo", "offer letter", "pay stub", "termination letter", "timeline", "document",
    "截圖", "截图", "郵件", "邮件", "內部信", "内部信", "通知", "薪資單", "薪资单", "資遣通知", "裁員通知", "离职证明", "時間線", "时间线", "文件",
  ]);
  const responseTerms = employerReviewTermMatches(text, [
    "management response", "hr response", "leadership response", "all hands", "town hall", "official statement", "internal announcement",
    "管理層回應", "管理层回应", "hr回應", "hr回应", "人資回應", "人资回应", "全員會", "全员会", "內部公告", "内部公告", "官方聲明", "官方声明",
  ]);
  const legalWhistleblowerTerms = employerReviewTermMatches(text, [
    "whistleblower", "retaliation", "labor board", "lawsuit", "settlement", "complaint filed", "osha", "eeoc", "union complaint",
    "吹哨", "報復", "报复", "勞工局", "劳动局", "勞動仲裁", "劳动仲裁", "訴訟", "诉讼", "和解", "工會申訴", "工会申诉",
  ]);
  const spreadTerms = employerReviewTermMatches(text, [
    "blind thread", "reddit", "linkedin", "twitter", "x post", "viral", "news coverage", "candidate warning", "offer rescinded",
    "社群", "社媒", "論壇", "论坛", "脈脈", "脉脉", "小紅書", "小红书", "領英", "领英", "新聞", "新闻", "候選人提醒", "候选人提醒",
  ]);
  const workforceImpactTerms = employerReviewTermMatches(text, [
    "layoff", "laid off", "restructuring", "downsizing", "redundancy", "hiring freeze", "offer rescinded", "attrition", "turnover", "people leaving", "burnout", "morale",
    "裁員", "裁员", "資遣", "资遣", "縮編", "缩编", "凍結招聘", "冻结招聘", "撤回offer", "離職", "离职", "流失", "士氣", "士气", "過勞", "过劳",
  ]);
  const severityTerms = employerReviewTermMatches(text, [
    "toxic", "harassment", "discrimination", "retaliation", "hostile work", "unsafe workplace", "workplace safety", "whistleblower", "labor board", "lawsuit", "investigation",
    "有毒", "騷擾", "骚扰", "歧視", "歧视", "報復", "报复", "不安全", "工安", "職安", "职安", "吹哨", "勞工局", "劳动局", "訴訟", "诉讼", "調查", "调查",
  ]);
  const remediationTerms = employerReviewTermMatches(text, [
    "severance", "corrective action", "action plan", "policy change", "internal investigation", "hr investigation", "town hall", "all hands", "management response", "hr response", "official statement",
    "資遣費", "资遣费", "補償", "补偿", "整改", "改進計畫", "改进计划", "政策調整", "政策调整", "內部調查", "内部调查", "全員會", "全员会", "官方聲明", "官方声明",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("employer_layoff_signal", "layoff or restructuring concern", /layoff|layoffs|laid off|restructuring|downsizing|redundancy|裁員|裁员|資遣|资遣|縮編|缩编/i.test(text), 16);
  addSignal("employer_culture_signal", "workplace culture concern", /culture|toxic|burnout|overwork|work-life|work life|workplace culture|職場文化|职场文化|有毒文化|過勞|过劳|加班/i.test(text), 12);
  addSignal("employer_leadership_signal", "leadership or management concern", /leadership|management|manager|executive|founder|ceo|communication|領導|领导|管理層|管理层|主管|溝通|沟通/i.test(text), 10);
  addSignal("employer_compensation_signal", "pay, benefit, or compensation concern", /salary|pay|compensation|benefits|bonus|equity|underpaid|薪資|薪资|工資|工资|福利|獎金|奖金/i.test(text), 10);
  addSignal("employer_discrimination_harassment_signal", "discrimination or harassment allegation", /discrimination|harassment|bullying|retaliation|hostile work|bias|歧視|歧视|騷擾|骚扰|霸凌|報復|报复/i.test(text), 18);
  addSignal("employer_turnover_signal", "attrition or retention concern", /turnover|attrition|quit|resignation|retention|people leaving|離職|离职|流失|留才/i.test(text), 10);
  addSignal("employer_union_labor_signal", "union, labor, or worker action", /union|labor dispute|strike|walkout|worker protest|collective bargaining|工會|工会|罷工|罢工|勞資|劳资/i.test(text), 14);
  addSignal("employer_safety_signal", "workplace safety or injury issue", /workplace safety|unsafe workplace|injury|accident|osha|hazard|工安|職安|职安|安全事故|受傷|受伤/i.test(text), 14);
  addSignal("employer_compliance_signal", "legal or compliance workplace issue", /lawsuit|legal|compliance|whistleblower|investigation|regulator|訴訟|诉讼|合規|合规|吹哨|調查|调查/i.test(text), 14);
  addSignal("employer_low_rating_signal", "negative employee review or rating language", /bad rating|low rating|negative review|one star|1 star|差評|差评|低評分|低评分|一星/i.test(text), 10);
  addSignal("employer_evidence_language_signal", "employee evidence language", evidenceTerms.length > 0, 12);
  addSignal("employer_response_language_signal", "management or HR response language", responseTerms.length > 0, 10);
  addSignal("employer_legal_whistleblower_signal", "labor legal, whistleblower, or retaliation language", legalWhistleblowerTerms.length > 0, 14);
  addSignal("employer_spread_language_signal", "employee-community or candidate-warning spread language", spreadTerms.length > 0, 10);
  addSignal("employer_workforce_impact_signal", "workforce impact, attrition, morale, hiring freeze, or offer impact language", workforceImpactTerms.length > 0, 10);
  addSignal("employer_severity_language_signal", "severe workplace allegation, safety, discrimination, retaliation, legal, or investigation language", severityTerms.length > 0, 12);
  addSignal("employer_remediation_language_signal", "severance, corrective action, policy, investigation, town hall, or official response language", remediationTerms.length > 0, 10);

  const semanticSignals = [
    out.employer_layoff_signal,
    out.employer_culture_signal,
    out.employer_leadership_signal,
    out.employer_compensation_signal,
    out.employer_discrimination_harassment_signal,
    out.employer_turnover_signal,
    out.employer_union_labor_signal,
    out.employer_safety_signal,
    out.employer_compliance_signal,
    out.employer_low_rating_signal,
    out.employer_evidence_language_signal,
    out.employer_response_language_signal,
    out.employer_legal_whistleblower_signal,
    out.employer_spread_language_signal,
    out.employer_workforce_impact_signal,
    out.employer_severity_language_signal,
    out.employer_remediation_language_signal,
  ].filter(Boolean).length;
  addSignal(
    "employer_complete_workplace_crisis_narrative_signal",
    "complete workplace crisis narrative with employee evidence, workforce impact, severity, employer response or legal escalation, and spread context",
    semanticSignals >= 8
      && out.employer_evidence_language_signal
      && out.employer_workforce_impact_signal
      && out.employer_severity_language_signal
      && (out.employer_response_language_signal || out.employer_remediation_language_signal || out.employer_legal_whistleblower_signal)
      && out.employer_spread_language_signal,
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    employer_workplace_risk_score: boundedScore,
    employer_workplace_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    employer_signal_count: signalFields.length,
    employer_workplace_semantic_signal_count: semanticSignals,
    employer_signal_reasons: [...new Set(reasons)].slice(0, 16),
    employer_evidence_terms: evidenceTerms,
    employer_response_terms: responseTerms,
    employer_legal_whistleblower_terms: legalWhistleblowerTerms,
    employer_spread_terms: spreadTerms,
    employer_workforce_impact_terms: workforceImpactTerms,
    employer_severity_terms: severityTerms,
    employer_remediation_terms: remediationTerms,
  };
}

function evidenceWithEmployerReviewMetadata(evidence = {}, item = {}, target = {}, failoverAttribution = [], content = "") {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const evidenceMetrics = evidence?.metrics || {};
  return {
    ...(evidence || {}),
    source_key: "employerReviewSources",
    evidence_type: "employer_review_source_result",
    metrics: {
      ...evidenceMetrics,
      ...employerWorkplaceRiskSignals({ item, target, content, metrics: evidenceMetrics }),
      source: "employer_review_source_search",
      employer_review_site: target.name || item.targetName || "",
      employer_review_site_key: target.key || item.targetKey || "",
      employer_signal_kind: target.tier || "",
      site_tags: Array.isArray(target.tags) ? target.tags : item.targetTags || [],
      target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
      source_weight_tier: target.tier || "",
      source_family: "review",
      reputation_axis: "employer-workplace",
      employer_review_canonical_dedupe_url: employerReviewDedupeKey(item),
      employer_review_search_scan_dedupe_key: employerReviewDedupeKey(item),
      employer_review_search_page: Math.max(1, Number(item.searchPage) || 1),
      employer_review_search_raw_result_count: Math.max(0, Number(item.searchRawResultCount) || 0),
      employer_review_matched_keyword: item.matchedKeyword || "",
      employer_review_keyword_match_source: employerReviewKeywordMatchSource(item, item.matchedKeyword || "", target),
      employer_review_direct_url: item.directUrl ? item.url : "",
      employer_review_direct_url_recovery: Boolean(item.directUrl),
      employer_review_collection_mode: item.directUrl ? "direct-url" : "search",
      ...(attribution.length ? {
        failover_attribution: attribution,
        failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
      } : {}),
    },
  };
}

async function insertEmployerReviewItems(items, { keyword, proxyUrl, enrich, target, seenItemUrls = null, domainControls = {}, contentControls = {}, failoverAttribution = [] }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = employerReviewDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const fallback = item.content || "";
    const enriched = enrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: fallback, ai_summary: fallback, enriched: false };
    const content = enriched.content || fallback;
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "employer_review_sources",
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
      evidence: evidenceWithEmployerReviewMetadata(enriched.evidence || {}, item, target, failoverAttribution, content),
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

export async function scrapeEmployerReviewSources(keywords, { proxyUrl = "", enrich = true, budget = {}, targets = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const selectedTargets = normalizeTargets(targets, targetProfiles).slice(0, normalizedBudget.maxTargetsPerKeyword);
  const seenItemUrls = new Set();
  let directInserted = 0;
  const directFailures = [];
  const directKeyword = normalizedKeywords[0] || "employer-review-direct-url";
  for (const { url, target } of directEmployerReviewTargets(normalizedDirectUrls, selectedTargets)) {
    try {
      const item = directEmployerReviewItem(url, directKeyword, target);
      if (!item) continue;
      directInserted += await insertEmployerReviewItems([item], {
        keyword: directKeyword,
        proxyUrl,
        enrich: true,
        target,
        seenItemUrls,
        domainControls,
        contentControls,
        failoverAttribution,
      });
    } catch (err) {
      directFailures.push({ keyword: directKeyword, target: url, message: formatSourceError(err, proxyUrl) });
    }
  }
  if (!normalizedKeywords.length) return scraperResult(directInserted, directFailures);
  const tasks = normalizedKeywords.flatMap(keyword => selectedTargets.map(target => ({ keyword, target })));

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    const query = `${keyword} employee review workplace culture layoffs rating complaint ${target.siteQuery}`;
    try {
      const found = [];
      const seenUrls = new Set();
      for (let page = 0; page < normalizedBudget.maxPagesPerTarget && found.length < normalizedBudget.maxItemsPerTarget; page += 1) {
        const params = new URLSearchParams({ q: query, kl: "us-en" });
        if (page > 0) params.set("s", String(page * 30));
        const url = `https://duckduckgo.com/html/?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: target.name, page: page + 1, message: httpFailure(res) });
          break;
        }
        const html = await res.text();
        const rawCount = countDuckDuckGoRawResults(html);
        const items = parseEmployerReviewSearchResults(html, keyword, target, normalizedBudget.maxItemsPerTarget - found.length);
        let pageFound = 0;
        for (const item of items) {
          const dedupeKey = employerReviewDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          found.push({ ...item, searchPage: page + 1, searchRawResultCount: rawCount, matchedKeyword: keyword });
          pageFound += 1;
          if (found.length >= normalizedBudget.maxItemsPerTarget) break;
        }
        if (!pageFound && !rawCount) break;
      }
      inserted += await insertEmployerReviewItems(found, { keyword, proxyUrl, enrich, target, seenItemUrls, domainControls, contentControls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.name, message });
      console.warn(`[CRM/EmployerReviewSources] 抓取失敗 keyword=${keyword} target=${target.name}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    directInserted + results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directFailures, ...results.flatMap(result => result?.failures || [])],
  );
}

export const __test__ = {
  normalizeBudget,
  normalizeTargets,
  normalizeDirectUrls,
  directEmployerReviewTargets,
  directEmployerReviewItem,
  isConcreteEmployerReviewUrl,
  normalizeProfileValues,
  targetMatchesProfiles,
  normalizeEmployerReviewKeywordText,
  employerReviewValueMatchesKeyword,
  normalizeEmployerReviewDedupeUrl,
  employerReviewDedupeKey,
  countDuckDuckGoRawResults,
  parseEmployerReviewSearchResults,
  employerReviewKeywordMatchSource,
  employerWorkplaceRiskSignals,
  EMPLOYER_REVIEW_TARGETS,
};
