/**
 * scrapers/social-search.js — Threads / Instagram public search fallback.
 *
 * Threads and Instagram do not provide a stable unauthenticated public search API for this app,
 * so these sources use Yahoo Taiwan search with site filters and store matched public results
 * under their own platform keys.
 */

import { scrapeYahooSearch } from "./yahoo-taiwan.js";
import { scraperResult } from "./http.js";

function socialTargetResult(results = []) {
  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

function normalizeSocialTargetList(values = []) {
  if (Array.isArray(values)) return values;
  if (typeof values === "string") return values.split(/[,\n，、;；]+/);
  return [];
}

export function normalizeThreadsProfiles(profiles = []) {
  const out = [];
  const seen = new Set();
  for (const item of normalizeSocialTargetList(profiles)) {
    const raw = String(item || "").trim();
    if (!raw) continue;
    let handle = raw;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== "threads.net") continue;
      const first = parsed.pathname.split("/").filter(Boolean)[0] || "";
      handle = first;
    } catch {
      handle = raw;
    }
    handle = handle
      .replace(/^https?:\/\/(?:www\.)?threads\.net\//i, "")
      .replace(/\/.*$/g, "")
      .replace(/^@?/, "@")
      .replace(/[^\w.@-]/g, "")
      .slice(0, 80);
    if (!/^@[\w.-]{2,}$/.test(handle)) continue;
    const key = handle.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(handle);
    }
    if (out.length >= 50) break;
  }
  return out;
}

export function normalizeInstagramProfiles(profiles = []) {
  const out = [];
  const seen = new Set();
  for (const item of normalizeSocialTargetList(profiles)) {
    const raw = String(item || "").trim();
    if (!raw) continue;
    let handle = raw;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== "instagram.com") continue;
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (!segments.length || /^(p|reel|tv|explore|stories|accounts)$/i.test(segments[0])) continue;
      handle = segments[0];
    } catch {
      handle = raw;
    }
    handle = handle
      .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "")
      .replace(/\/.*$/g, "")
      .replace(/^@/, "")
      .replace(/[^\w.-]/g, "")
      .slice(0, 80);
    if (!/^[\w.]{2,}$/.test(handle)) continue;
    const key = handle.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(handle);
    }
    if (out.length >= 50) break;
  }
  return out;
}

function socialSearchTargets(platform, profiles = []) {
  if (platform === "threads") {
    return [
      { scope: "global", siteQuery: "site:threads.net" },
      ...normalizeThreadsProfiles(profiles).map(profile => ({
        scope: "profile",
        profile,
        siteQuery: `site:threads.net/${profile}`,
      })),
    ];
  }
  return [
    { scope: "global", siteQuery: "site:instagram.com" },
    ...normalizeInstagramProfiles(profiles).map(profile => ({
      scope: "profile",
      profile,
      siteQuery: `site:instagram.com/${profile}`,
    })),
  ];
}

function normalizeSocialSearchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function socialSearchTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeSocialSearchText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeSocialSearchText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

export function isConcreteThreadsUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "threads.net") return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(login|privacy|terms|about|help|search|explore|activity|settings)$/i.test(segments[0])) return false;
    if (segments[0].startsWith("@") && /^post$/i.test(segments[1] || "") && segments[2]) return true;
    if (/^t$/i.test(segments[0]) && segments[1]) return true;
    return false;
  } catch {
    return false;
  }
}

export function isConcreteInstagramUrl(value = "") {
  try {
    const url = new URL(String(value || "").trim());
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "instagram.com") return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return false;
    if (/^(p|reel|tv)$/i.test(segments[0]) && segments[1]) return true;
    return false;
  } catch {
    return false;
  }
}

export function socialPublicSearchNarrativeSignals({ item = {}, platform = "", target = {}, metrics = {} } = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${item.url || ""}`;
  const crisisTerms = socialSearchTermMatches(text, [
    "complaint", "refund", "dispute", "scam", "fraud", "breach", "privacy", "outage", "boycott", "crisis",
    "投訴", "投诉", "退款", "爭議", "争议", "詐騙", "诈骗", "外洩", "泄露", "隱私", "隐私", "故障", "抵制", "危機", "危机",
  ]);
  const evidenceTerms = socialSearchTermMatches(text, [
    "screenshot", "screen recording", "proof", "evidence", "receipt", "order", "timeline", "record", "documents",
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "憑證", "凭证", "收據", "收据", "訂單", "订单", "時間線", "时间线", "紀錄", "记录",
  ]);
  const impactTerms = socialSearchTermMatches(text, [
    "customer", "consumer", "user", "loss", "support", "service", "payment", "refund", "safety", "privacy",
    "客服", "消費者", "消费者", "用戶", "用户", "受害", "損失", "损失", "款項", "款项", "安全", "隱私", "隐私",
  ]);
  const responseTerms = socialSearchTermMatches(text, [
    "official", "response", "statement", "apology", "support replied", "clarification", "resolved", "workaround",
    "官方", "回應", "回应", "聲明", "声明", "道歉", "致歉", "澄清", "說明", "说明", "客服回覆", "客服回复", "處理", "处理",
  ]);
  const propagationTerms = socialSearchTermMatches(text, [
    "viral", "spread", "spreading", "trending", "shared", "repost", "thread", "comments", "public post", "social",
    "擴散", "扩散", "發酵", "发酵", "熱議", "热议", "轉傳", "转传", "轉發", "转发", "社群", "社交", "公開貼文", "公开贴文", "討論", "讨论",
  ]);
  const concretePost = platform === "threads"
    ? isConcreteThreadsUrl(item.url)
    : platform === "instagram"
      ? isConcreteInstagramUrl(item.url)
      : false;
  const profileScope = target?.scope === "profile" || Boolean(target?.profile);
  const indexedSearch = Number(metrics.yahoo_taiwan_search_raw_result_count || 0) > 0 || Number(metrics.yahoo_taiwan_search_page || 0) > 0;
  const authorEvidence = Boolean(metrics.social_author || item.author || profileScope);
  const reasons = [];
  if (concretePost) reasons.push("social-public-concrete-post-url");
  if (profileScope) reasons.push("social-public-profile-scope");
  if (indexedSearch) reasons.push("social-public-indexed-search-hit");
  if (authorEvidence) reasons.push("social-public-author-evidence");
  if (crisisTerms.length) reasons.push("social-public-crisis-language");
  if (evidenceTerms.length) reasons.push("social-public-evidence-language");
  if (impactTerms.length) reasons.push("social-public-impact-language");
  if (responseTerms.length) reasons.push("social-public-response-language");
  if (propagationTerms.length) reasons.push("social-public-propagation-language");
  const semanticSignals = [
    concretePost,
    crisisTerms.length,
    evidenceTerms.length || impactTerms.length,
    responseTerms.length || authorEvidence,
    propagationTerms.length || indexedSearch || profileScope,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  if (completeNarrative) reasons.push("social-public-complete-crisis-narrative");
  return {
    social_public_platform: platform,
    social_public_concrete_post_signal: concretePost ? 1 : 0,
    social_public_profile_scope_signal: profileScope ? 1 : 0,
    social_public_indexed_search_signal: indexedSearch ? 1 : 0,
    social_public_author_evidence_signal: authorEvidence ? 1 : 0,
    social_public_crisis_signal: crisisTerms.length ? 1 : 0,
    social_public_evidence_signal: evidenceTerms.length ? 1 : 0,
    social_public_impact_signal: impactTerms.length ? 1 : 0,
    social_public_response_signal: responseTerms.length ? 1 : 0,
    social_public_propagation_signal: propagationTerms.length ? 1 : 0,
    social_public_semantic_signal_count: semanticSignals,
    social_public_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    social_public_crisis_terms: crisisTerms,
    social_public_evidence_terms: evidenceTerms,
    social_public_impact_terms: impactTerms,
    social_public_response_terms: responseTerms,
    social_public_propagation_terms: propagationTerms,
    social_public_narrative_reasons: reasons,
  };
}

async function scrapeSocialSearchTargets(keywords, {
  proxyUrl = "",
  enrich = true,
  budget = {},
  deepBudget = null,
  domainControls = {},
  contentControls = {},
  platform,
  author,
  profiles = [],
  allowedHostPattern,
  resultUrlFilter,
  logPrefix,
  querySuffix = "",
  requireTaiwan = false,
}) {
  const results = [];
  for (const target of socialSearchTargets(platform, profiles)) {
    results.push(await scrapeYahooSearch(keywords, {
      proxyUrl,
      enrich,
      budget,
      deepBudget,
      domainControls,
      contentControls,
      platform,
      author: target.profile ? `${author} ${target.profile}` : author,
      siteQuery: target.siteQuery,
      querySuffix,
      requireTaiwan,
      allowedHostPattern,
      resultUrlFilter,
      logPrefix: target.profile ? `${logPrefix}/${target.profile}` : logPrefix,
      metricsEnhancer: ({ item, platform: sourcePlatform, metrics }) => socialPublicSearchNarrativeSignals({
        item,
        platform: sourcePlatform,
        target,
        metrics,
      }),
    }));
  }
  return socialTargetResult(results);
}

export function scrapeThreads(keywords, {
  proxyUrl = "",
  enrich = true,
  budget = {},
  deepBudget = null,
  domainControls = {},
  contentControls = {},
  profiles = [],
  accounts = [],
  handles = [],
  querySuffix = "",
  requireTaiwan = false,
} = {}) {
  return scrapeSocialSearchTargets(keywords, {
    proxyUrl,
    enrich,
    budget,
    deepBudget,
    domainControls,
    contentControls,
    platform: "threads",
    author: "Threads 公開搜尋",
    profiles: [profiles, accounts, handles].flat(),
    allowedHostPattern: /(^|\.)threads\.net$/,
    resultUrlFilter: isConcreteThreadsUrl,
    logPrefix: "Threads",
    querySuffix,
    requireTaiwan,
  });
}

export function scrapeInstagram(keywords, {
  proxyUrl = "",
  enrich = true,
  budget = {},
  deepBudget = null,
  domainControls = {},
  contentControls = {},
  profiles = [],
  accounts = [],
  handles = [],
  querySuffix = "",
  requireTaiwan = false,
} = {}) {
  return scrapeSocialSearchTargets(keywords, {
    proxyUrl,
    enrich,
    budget,
    deepBudget,
    domainControls,
    contentControls,
    platform: "instagram",
    author: "Instagram / INS 公開搜尋",
    profiles: [profiles, accounts, handles].flat(),
    allowedHostPattern: /(^|\.)instagram\.com$/,
    resultUrlFilter: isConcreteInstagramUrl,
    logPrefix: "Instagram",
    querySuffix,
    requireTaiwan,
  });
}

export const __test__ = {
  normalizeThreadsProfiles,
  normalizeInstagramProfiles,
  socialSearchTargets,
  isConcreteThreadsUrl,
  isConcreteInstagramUrl,
  socialPublicSearchNarrativeSignals,
};
