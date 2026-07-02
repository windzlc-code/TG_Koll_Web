import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_SEARCH_URL = "https://tw.search.yahoo.com/search";
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const SITE_SCOPES = ["linkedin.com/posts", "linkedin.com/feed/update", "linkedin.com/company", "linkedin.com/pulse", "linkedin.com/in"];

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ensp;|&#8194;/gi, " ")
    .replace(/&emsp;|&#8195;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html, max = 1200) {
  return decodeHtml(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
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

function normalizeYahooRedirectUrl(rawUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded) return "";
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
    if (/r\.search\.yahoo\.com$/i.test(url.hostname)) {
      const ru = /\/RU=([^/]+)/.exec(url.pathname);
      if (ru?.[1]) return normalizeYahooRedirectUrl(decodeURIComponent(ru[1]));
      const direct = url.searchParams.get("u") || url.searchParams.get("url");
      if (direct) return normalizeYahooRedirectUrl(decodeURIComponent(direct));
    }
    url.hash = "";
    return url.toString();
  } catch {
    return decoded;
  }
}

function isLinkedInHost(hostname = "") {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  return host === "linkedin.com";
}

function normalizeLinkedInUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!isLinkedInHost(url.hostname)) return "";
    url.hostname = "www.linkedin.com";
    url.protocol = "https:";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    for (const key of ["trk", "originalSubdomain", "lipi", "miniProfileUrn", "midSig", "trackingId", "refId", "ref", "eBP", "eid", "recommendedFlavor", "rcm", "sessionRedirect", "fromSignIn"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeLinkedInDedupeUrl(value = "") {
  const normalized = normalizeLinkedInUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    for (const key of ["trk", "originalSubdomain", "lipi", "miniProfileUrn", "midSig", "trackingId", "refId", "ref", "eBP", "eid", "recommendedFlavor", "rcm", "sessionRedirect", "fromSignIn"]) {
      url.searchParams.delete(key);
    }
    url.hostname = "www.linkedin.com";
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function linkedinSearchDedupeKey(item = {}) {
  return normalizeLinkedInDedupeUrl(item?.url || "");
}

function normalizeLinkedInKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function linkedinKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeLinkedInKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function linkedinValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeLinkedInKeywordText(value);
  return linkedinKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeLinkedInKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function linkedinKeywordMatchSource(item = {}, keyword = "") {
  if (!linkedinKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["linkedin_evidence_kind", item.metrics?.linkedin_evidence_kind],
    ["search_scope", item.metrics?.search_scope],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (linkedinValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function linkedinKeywordDiagnostics(item = {}, keyword = "") {
  return {
    linkedin_matched_keyword: stripTags(keyword, 160),
    linkedin_keyword_match_source: linkedinKeywordMatchSource(item, keyword),
  };
}

function isConcreteLinkedInUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!isLinkedInHost(parsed.hostname)) return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (segments[0] === "feed") return segments[1] === "update" && segments.length >= 3;
    if (/^(login|signup|authwall|checkpoint|uas|jobs|search|mynetwork|notifications|messaging|help|legal|directory|sales|talent|learning)$/i.test(segments[0])) return false;
    if (["posts", "pulse", "company", "showcase", "school", "in"].includes(segments[0])) return segments.length >= 2;
    return false;
  } catch {
    return false;
  }
}

function linkedinEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "posts" || (segments[0] === "feed" && segments[1] === "update")) return "post";
    if (segments[0] === "pulse") return "article";
    if (segments[0] === "company") return "company";
    if (segments[0] === "showcase") return "showcase";
    if (segments[0] === "school") return "school";
    if (segments[0] === "in") return "profile";
    return "public-page";
  } catch {
    return "";
  }
}

function linkedinEvidenceRole(kind = "") {
  if (kind === "post") return "conversation_post";
  if (kind === "article") return "longform_article";
  if (kind === "company" || kind === "showcase" || kind === "school") return "organization_profile";
  if (kind === "profile") return "person_profile";
  return "public_page";
}

function linkedinEvidenceType(kind = "") {
  if (kind === "post") return "linkedin_public_post";
  if (kind === "article") return "linkedin_public_article";
  if (kind === "company" || kind === "showcase" || kind === "school") return "linkedin_public_organization_profile";
  if (kind === "profile") return "linkedin_public_person_profile";
  return "linkedin_public_search_result";
}

function linkedinB2BRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function linkedinB2BRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "complaint", "complaints", "refund", "chargeback", "dispute", "customer support",
    "support delay", "scam", "fraud", "boycott", "crisis", "apology", "backlash",
    "public response", "reputation risk",
    "投訴", "投诉", "退款", "客服", "維權", "维权", "爭議", "争议", "危機", "危机",
    "道歉", "抵制", "爆料", "曝光",
  ].filter(term => text.includes(term.toLowerCase()));
  const b2bTerms = [
    "partner concern", "partner concerns", "supplier concern", "customer concern",
    "client concern", "enterprise customer", "b2b reputation", "b2b reputation risk",
    "vendor risk", "procurement risk", "contract risk", "brand safety", "stakeholder",
    "合作伙伴", "夥伴", "供应商", "供應商", "客户担忧", "客戶擔憂", "企业客户", "企業客戶", "采购风险", "採購風險",
  ].filter(term => text.includes(term.toLowerCase()));
  const workplaceTerms = [
    "employee discussion", "employee concern", "employees", "staff", "layoff", "workplace",
    "recruiting", "hiring", "leadership", "executive", "internal",
    "員工", "员工", "内部", "內部", "招聘", "管理層", "管理层", "高管",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline", "contract",
    "chat log", "order", "invoice", "documentation", "documents", "emails", "case study",
    "截图", "截圖", "证据", "證據", "凭证", "憑證", "合同", "聊天记录", "聊天紀錄", "订单", "訂單",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "shared", "reposted", "comments", "discussion", "industry discussion", "public backlash",
    "media attention", "analyst", "investor", "market concern", "viral", "spreading",
    "行业讨论", "產業討論", "行业热议", "熱議", "热议", "扩散", "擴散", "发酵", "發酵", "投资者", "投資者",
  ].filter(term => text.includes(term.toLowerCase()));
  const impactTerms = [
    "partner concern", "partner concerns", "supplier concern", "customer concern", "client concern",
    "enterprise customer", "b2b reputation risk", "vendor risk", "procurement risk", "contract risk",
    "brand safety", "market concern", "investor", "analyst", "employee discussion",
    "合作伙伴", "夥伴", "供应商", "供應商", "客户担忧", "客戶擔憂", "企业客户", "企業客戶", "采购风险", "採購風險", "品牌安全", "投资者", "投資者",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = [
    "public response", "official response", "company response", "leadership response", "apology",
    "statement", "clarification", "town hall", "all hands", "remediation", "action plan",
    "公開回應", "公开回应", "官方回應", "官方回应", "公司回應", "公司回应", "管理層回應", "管理层回应", "道歉", "聲明", "声明", "澄清", "整改",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.linkedin_search_raw_result_count || 0));
  const evidenceKind = metrics.linkedin_evidence_kind || linkedinEvidenceKind(item.url);
  const evidenceRole = metrics.linkedin_evidence_role || linkedinEvidenceRole(evidenceKind);
  const isConversation = ["post", "article"].includes(evidenceKind) || evidenceRole === "conversation_post" || evidenceRole === "longform_article";
  const isProfile = ["company", "showcase", "school", "profile"].includes(evidenceKind);
  const isCompany = ["company", "showcase", "school"].includes(evidenceKind);
  const indexedScope = Boolean(metrics.search_scope);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = linkedinKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isConversation) reasons.push(evidenceKind === "article" ? "linkedin-article-url" : "linkedin-post-url");
  if (isProfile) reasons.push("linkedin-profile-url");
  if (isCompany) reasons.push("linkedin-company-scope");
  if (complaintTerms.length) reasons.push("complaint-language");
  if (b2bTerms.length) reasons.push("b2b-stakeholder-language");
  if (workplaceTerms.length) reasons.push("workplace-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (amplificationTerms.length) reasons.push("amplification-language");
  if (impactTerms.length) reasons.push("b2b-impact-language");
  if (responseTerms.length) reasons.push("response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (indexedScope) reasons.push("linkedin-indexed-scope");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");

  const semanticSignalCount = [
    isConversation,
    isProfile,
    isCompany,
    complaintTerms.length,
    b2bTerms.length,
    workplaceTerms.length,
    evidenceTerms.length,
    amplificationTerms.length,
    impactTerms.length,
    responseTerms.length,
    rawResultCount > 1,
    indexedScope,
    enriched,
    titleMatch,
  ].filter(Boolean).length;
  const completeNarrative = isConversation
    && complaintTerms.length > 0
    && b2bTerms.length > 0
    && impactTerms.length > 0
    && evidenceTerms.length > 0
    && amplificationTerms.length > 0
    && semanticSignalCount >= 7;

  const rawScore =
    (isConversation ? 14 : 0)
    + (isProfile ? 8 : 0)
    + (isCompany ? 6 : 0)
    + (complaintTerms.length ? 22 : 0)
    + (b2bTerms.length ? 18 : 0)
    + (workplaceTerms.length ? 12 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (amplificationTerms.length ? 14 : 0)
    + (impactTerms.length ? 10 : 0)
    + (responseTerms.length ? 8 : 0)
    + (completeNarrative ? 12 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (indexedScope ? 4 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0);
  const cappedScore = isProfile && !isConversation && !evidenceTerms.length && !amplificationTerms.length
    ? Math.min(rawScore, 68)
    : rawScore;
  const score = Math.min(100, Math.max(0, cappedScore));

  return {
    linkedin_b2b_conversation_signal: isConversation ? 1 : 0,
    linkedin_b2b_profile_signal: isProfile ? 1 : 0,
    linkedin_b2b_company_signal: isCompany ? 1 : 0,
    linkedin_b2b_complaint_signal: complaintTerms.length ? 1 : 0,
    linkedin_b2b_stakeholder_signal: b2bTerms.length ? 1 : 0,
    linkedin_b2b_workplace_signal: workplaceTerms.length ? 1 : 0,
    linkedin_b2b_evidence_signal: evidenceTerms.length ? 1 : 0,
    linkedin_b2b_amplification_signal: amplificationTerms.length ? 1 : 0,
    linkedin_b2b_impact_signal: impactTerms.length ? 1 : 0,
    linkedin_b2b_response_signal: responseTerms.length ? 1 : 0,
    linkedin_b2b_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    linkedin_b2b_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    linkedin_b2b_stakeholder_terms: [...new Set(b2bTerms)].slice(0, 12),
    linkedin_b2b_workplace_terms: [...new Set(workplaceTerms)].slice(0, 12),
    linkedin_b2b_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    linkedin_b2b_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    linkedin_b2b_impact_terms: [...new Set(impactTerms)].slice(0, 12),
    linkedin_b2b_response_terms: [...new Set(responseTerms)].slice(0, 12),
    linkedin_b2b_index_scope_signal: indexedScope ? 1 : 0,
    linkedin_b2b_deep_evidence_signal: enriched ? 1 : 0,
    linkedin_b2b_semantic_signal_count: semanticSignalCount,
    linkedin_b2b_risk_score: score,
    linkedin_b2b_risk_bucket: linkedinB2BRiskBucket(score),
    linkedin_b2b_risk_signal_count: [...new Set(reasons)].length,
    linkedin_b2b_risk_reasons: [...new Set(reasons)],
  };
}

function parseSearchDate(text = "", now = new Date()) {
  const source = String(text || "");
  const absoluteZh = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(source);
  if (absoluteZh) return new Date(Number(absoluteZh[1]), Number(absoluteZh[2]) - 1, Number(absoluteZh[3]), 12, 0, 0);
  const absoluteEn = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(source);
  if (absoluteEn) return new Date(`${absoluteEn[1]} ${absoluteEn[2]}, ${absoluteEn[3]} 12:00:00`);
  const relativeZh = /(\d+)\s*(分鐘|分钟|小時|小时|天|日)前/.exec(source);
  if (relativeZh) {
    const amount = Number(relativeZh[1]);
    if (!Number.isFinite(amount)) return null;
    if (/分鐘|分钟/.test(relativeZh[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/小時|小时/.test(relativeZh[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  const relativeEn = /(\d+)\s*(minute|minutes|hour|hours|day|days)\s+ago/i.exec(source);
  if (relativeEn) {
    const amount = Number(relativeEn[1]);
    if (!Number.isFinite(amount)) return null;
    if (/minute/i.test(relativeEn[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/hour/i.test(relativeEn[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  return null;
}

function countLinkedInRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeLinkedInUrl(match[1]);
    if (url && isConcreteLinkedInUrl(url)) count += 1;
  }
  return count;
}

export function parseLinkedInSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeLinkedInUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteLinkedInUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!linkedinValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseSearchDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    const evidenceKind = linkedinEvidenceKind(url);
    out.push({
      url,
      title,
      content,
      author: "LinkedIn 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_site_linkedin",
        source_kind: "linkedin_public_search",
        linkedin_evidence_kind: evidenceKind,
        linkedin_evidence_role: linkedinEvidenceRole(evidenceKind),
        linkedin_profile_result: ["company", "showcase", "school", "profile"].includes(evidenceKind) ? 1 : 0,
        linkedin_conversation_result: ["post", "article"].includes(evidenceKind) ? 1 : 0,
        collection_mode: "site_linkedin_public_search",
      },
    });
    out[out.length - 1].metrics = {
      ...(out[out.length - 1].metrics || {}),
      ...linkedinB2BRiskSignals(out[out.length - 1], keyword),
    };
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertLinkedInItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = linkedinSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls?.has(dedupeKey)) continue;
    seenItemUrls?.add(dedupeKey);
    const shouldEnrich = enrich && deepPagesUsed < maxDeepPages;
    const enriched = shouldEnrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: item.content, ai_summary: item.content, enriched: false };
    if (shouldEnrich) deepPagesUsed += 1;
    const content = enriched.content || item.content || "";
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const finalMetrics = {
      ...evidenceMetrics,
      ...linkedinB2BRiskSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const result = insertSentimentItem({
      platform: "linkedin",
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
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: enriched.evidence?.evidence_type || linkedinEvidenceType(finalMetrics.linkedin_evidence_kind),
        metrics: {
          ...finalMetrics,
          ...linkedinKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          linkedin_canonical_dedupe_url: dedupeKey,
          linkedin_search_scan_dedupe_key: dedupeKey,
        },
      },
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeLinkedInSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (const scope of SITE_SCOPES) {
      if (keywordInserted >= maxItemsPerKeyword) break;
      for (let page = 0; page < maxPagesPerKeyword; page += 1) {
        const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
        if (remaining <= 0) break;
        const query = `${keyword} site:${scope}`;
        const start = page * 10 + 1;
        const url = `${YAHOO_SEARCH_URL}?p=${encodeURIComponent(query)}&fr=yfp-search-sb&fr2=time&ei=UTF-8&b=${start}`;
        try {
          const res = await fetchPublicSource(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, scope, message: httpFailure(res) });
            continue;
          }
          const html = await res.text();
          const rawResultCount = countLinkedInRawResults(html);
          const items = parseLinkedInSearchResults(html, keyword, {
            limit: remaining,
            since,
          }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              search_scope: scope,
              linkedin_search_page: page + 1,
              linkedin_search_start: start,
              linkedin_search_raw_result_count: rawResultCount,
            },
          })).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ...linkedinB2BRiskSignals(item, keyword),
            },
          }));
          const count = await insertLinkedInItems(items, {
            keyword,
            proxyUrl,
            enrich,
            maxDeepPages,
            domainControls,
            contentControls,
            seenItemUrls,
          });
          inserted += count;
          keywordInserted += count;
        } catch (err) {
          const message = formatSourceError(err, proxyUrl);
          failures.push({ keyword, scope, message });
          console.warn(`[Sentiment/LinkedIn] 抓取失敗 keyword=${keyword} scope=${scope}: ${message}`);
        }
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  linkedinSearchDedupeKey,
  linkedinEvidenceKind,
  linkedinEvidenceRole,
  linkedinEvidenceType,
  isConcreteLinkedInUrl,
  normalizeBudget,
  normalizeLinkedInDedupeUrl,
  normalizeLinkedInUrl,
  parseLinkedInSearchResults,
  countLinkedInRawResults,
  normalizeLinkedInKeywordText,
  linkedinValueMatchesKeyword,
  linkedinKeywordMatchSource,
  linkedinKeywordDiagnostics,
  linkedinB2BRiskBucket,
  linkedinB2BRiskSignals,
};
