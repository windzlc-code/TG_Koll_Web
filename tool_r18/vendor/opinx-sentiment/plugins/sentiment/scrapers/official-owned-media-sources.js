/**
 * scrapers/official-owned-media-sources.js - official owned-media discovery
 *
 * Collects no-key official company/brand newsroom, blog, press, RSS/Atom, and
 * sitemap signals from explicitly configured domains or domains present in
 * monitored keywords.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DETAIL_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 10;
const DEFAULT_MAX_DETAIL_PAGES_PER_KEYWORD = 2;
const DEFAULT_MAX_DISCOVERED_FEEDS_PER_TARGET = 2;
const OWNED_MEDIA_PATH_HINTS = [
  "/news",
  "/newsroom",
  "/press",
  "/press-releases",
  "/media",
  "/media-center",
  "/media-centre",
  "/company/news",
  "/about/news",
  "/ir/news",
  "/investors/news",
  "/investor-relations/news",
  "/blog",
  "/updates",
  "/stories",
  "/announcements",
  "/company/announcements",
  "/corporate/news",
  "/trust",
  "/trust-and-safety",
  "/security",
  "/incident-response",
  "/feed",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/sitemap.xml",
];
const OFFICIAL_INTENT_TERMS = [
  "statement",
  "response",
  "announces",
  "announcement",
  "press release",
  "newsroom",
  "incident",
  "security",
  "outage",
  "update",
  "recall",
  "investigation",
  "公告",
  "聲明",
  "声明",
  "回應",
  "回应",
  "宣布",
  "事件",
  "事故",
  "安全",
  "召回",
];

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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
  const maxTargets = Math.round(Number(budget.maxTargetsPerKeyword || budget.max_targets_per_keyword || DEFAULT_MAX_TARGETS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(12, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
  };
}

function normalizeDetailBudget(deepBudget = {}, budget = {}) {
  const explicit = deepBudget.maxDetailPagesPerKeyword
    ?? deepBudget.max_detail_pages_per_keyword
    ?? deepBudget.maxPagesPerKeyword
    ?? deepBudget.max_pages_per_keyword
    ?? budget.maxDetailPagesPerKeyword
    ?? budget.max_detail_pages_per_keyword
    ?? DEFAULT_MAX_DETAIL_PAGES_PER_KEYWORD;
  const maxDetailPages = Math.round(Number(explicit));
  return {
    maxDetailPagesPerKeyword: Number.isFinite(maxDetailPages) ? Math.max(0, Math.min(12, maxDetailPages)) : DEFAULT_MAX_DETAIL_PAGES_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function absoluteUrl(rawUrl = "", baseUrl = "") {
  const cleaned = String(rawUrl || "").trim();
  if (!cleaned || /^(?:javascript|mailto|tel):/i.test(cleaned)) return "";
  try {
    const url = new URL(cleaned, baseUrl || undefined);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hostnameFromText(value = "") {
  const text = cleanText(value, 500).toLowerCase();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ? url.hostname.replace(/^www\./, "") : "";
  } catch {
    const match = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i);
    return match ? match[1].replace(/^www\./, "") : "";
  }
}

function sameSite(url = "", host = "") {
  try {
    const candidate = new URL(url);
    const normalizedHost = String(host || "").replace(/^www\./i, "").toLowerCase();
    const urlHost = candidate.hostname.replace(/^www\./i, "").toLowerCase();
    return urlHost === normalizedHost || urlHost.endsWith(`.${normalizedHost}`);
  } catch {
    return false;
  }
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeOfficialOwnedKeywordText(raw);
  const host = hostnameFromText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, host, host.split(".")[0], ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeOfficialOwnedKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeOfficialOwnedKeywordText(text);
  return keywordNeedles(keyword).some(needle => {
    const normalized = normalizeOfficialOwnedKeywordText(needle);
    return needle.length >= 2 && (lower.includes(needle) || (normalized.length >= 2 && compact.includes(normalized)));
  });
}

function textHasOfficialIntent(text = "") {
  const lower = String(text || "").toLowerCase();
  return OFFICIAL_INTENT_TERMS.some(term => lower.includes(term.toLowerCase()));
}

function tagValue(block = "", tag = "") {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(match[1]) : "";
}

function attrValue(tag = "", attr = "") {
  const match = String(tag || "").match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i"));
  return match ? cleanText(match[1], 900) : "";
}

function linkValue(block = "", baseUrl = "") {
  const direct = tagValue(block, "link");
  if (direct) return absoluteUrl(direct, baseUrl);
  const linkTag = String(block || "").match(/<link\b[^>]*>/i)?.[0] || "";
  return absoluteUrl(attrValue(linkTag, "href"), baseUrl);
}

function normalizeOfficialOwnedDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ref"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return raw.split("#")[0].trim().toLowerCase();
  }
}

function normalizeOfficialOwnedDirectUrls(directUrls = []) {
  const raw = Array.isArray(directUrls)
    ? directUrls
    : typeof directUrls === "string"
      ? directUrls.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const url = absoluteUrl(value);
    const key = normalizeOfficialOwnedDedupeUrl(url);
    if (!url || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function officialOwnedDedupeKey(item = {}) {
  return normalizeOfficialOwnedDedupeUrl(item.url || "");
}

function officialOwnedKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["target_label", metrics.official_owned_target_label],
    ["site_host", metrics.official_owned_site_host],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword(value || "", keyword));
  return match ? match[0] : metrics.official_owned_target_matched_keyword ? "target" : "";
}

function officialOwnedKeywordDiagnostics(item = {}, keyword = "") {
  return {
    official_owned_matched_keyword: cleanText(keyword, 160),
    official_owned_keyword_match_source: officialOwnedKeywordMatchSource(item, keyword),
  };
}

function officialOwnedResponseBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function matchedOfficialOwnedTerms(text = "", terms = [], limit = 10) {
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

function officialOwnedResponseSignals({ title = "", content = "", url = "", sourceKind = "" } = {}) {
  const text = cleanText(`${title} ${content} ${url} ${sourceKind}`, 3200).toLowerCase();
  const evidenceTerms = matchedOfficialOwnedTerms(text, [
    "incident id", "case number", "reference number", "ticket", "log", "audit log", "screenshot", "receipt", "order id",
    "事件编号", "事件編號", "工单", "工單", "日志", "日誌", "截图", "截圖", "凭证", "憑證", "订单号", "訂單號",
  ]);
  const impactScopeTerms = matchedOfficialOwnedTerms(text, [
    "affected customers", "affected users", "affected accounts", "affected regions", "impacted customers", "impacted users",
    "limited subset", "all customers", "merchants", "sellers", "buyers", "checkout", "payment", "login",
    "受影响客户", "受影響客戶", "受影响用户", "受影響用戶", "影响范围", "影響範圍", "部分用户", "部分用戶", "全部用户", "全部用戶",
  ]);
  const rootCauseTerms = matchedOfficialOwnedTerms(text, [
    "root cause", "postmortem", "post-mortem", "rca", "preliminary findings", "investigation found", "caused by",
    "根因", "原因分析", "复盘", "復盤", "初步调查", "初步調查", "调查发现", "調查發現",
  ]);
  const actionTerms = matchedOfficialOwnedTerms(text, [
    "corrective action", "action plan", "additional safeguards", "monitoring", "audit", "review", "staffing", "training",
    "we will", "will implement", "will update", "next update",
    "整改", "改进", "改進", "专项检查", "專項檢查", "加强监控", "加強監控", "补充人手", "補充人手", "后续更新", "後續更新",
  ]);
  const supportTerms = matchedOfficialOwnedTerms(text, [
    "faq", "frequently asked questions", "help center", "support center", "contact support", "hotline", "claim form", "refund form",
    "客服", "帮助中心", "幫助中心", "常见问题", "常見問題", "热线", "熱線", "申诉", "申訴", "退款表单", "退款表單",
  ]);
  const externalReferenceTerms = matchedOfficialOwnedTerms(text, [
    "status page", "regulator", "regulatory", "law enforcement", "third party", "independent audit", "security researcher", "media report",
    "狀態頁", "状态页", "监管", "監管", "执法", "執法", "第三方", "独立审计", "獨立審計", "安全研究员", "安全研究員", "媒体报道", "媒體報導",
  ]);
  const statement = /statement|response|update|notice|announcement|press release|聲明|声明|回應|回应|公告|通告|說明|说明/.test(text);
  const incident = /incident|outage|disruption|degradation|security|vulnerability|breach|recall|investigation|故障|中断|中斷|事故|事件|安全|漏洞|外洩|泄露|召回|調查|调查/.test(text);
  const apology = /apolog|sorry|regret|致歉|道歉|抱歉|遺憾|遗憾/.test(text);
  const acknowledgement = /acknowledge|confirmed|aware|identified|we know|we are aware|確認|确认|注意到|已知悉|發現|发现|識別|识别/.test(text);
  const remediation = /fix|fixed|patch|restore|restored|resolved|workaround|mitigation|remediation|修复|修復|恢復|恢复|解決|解决|補救|补救|緩解|缓解|臨時方案|临时方案/.test(text);
  const compensation = /refund|compensation|credit|rebate|waive|voucher|退款|賠償|赔偿|補償|补偿|抵扣|優惠券|优惠券/.test(text);
  const customerImpact = /customer|user|client|member|merchant|seller|buyer|account|payment|checkout|order|delivery|login|客戶|客户|用戶|用户|會員|会员|商戶|商户|支付|付款|訂單|订单|配送|登入|登录/.test(text);
  const timeline = /timeline|next update|will update|status page|postmortem|root cause|rca|時間線|时间线|後續更新|后续更新|狀態頁|状态页|复盘|復盤|根因/.test(text);
  const legalCompliance = /regulator|regulatory|law enforcement|privacy|data protection|compliance|legal|監管|监管|執法|执法|隱私|隐私|資料保護|数据保护|合規|合规|法律/.test(text);
  const denial = /deny|false|inaccurate|misleading|rumor|rumour|not accurate|澄清|不實|不实|謠言|谣言|否認|否认|误导|誤導/.test(text);
  const reasons = [];
  if (statement) reasons.push("official-statement-language");
  if (incident) reasons.push("incident-risk-language");
  if (apology) reasons.push("apology-language");
  if (acknowledgement) reasons.push("acknowledgement-language");
  if (remediation) reasons.push("remediation-language");
  if (compensation) reasons.push("compensation-language");
  if (customerImpact) reasons.push("customer-impact-language");
  if (timeline) reasons.push("timeline-followup-language");
  if (legalCompliance) reasons.push("legal-compliance-language");
  if (denial) reasons.push("denial-clarification-language");
  if (evidenceTerms.length) reasons.push("official-evidence-reference");
  if (impactScopeTerms.length) reasons.push("impact-scope-language");
  if (rootCauseTerms.length) reasons.push("root-cause-postmortem-language");
  if (actionTerms.length) reasons.push("action-commitment-language");
  if (supportTerms.length) reasons.push("support-faq-routing-language");
  if (externalReferenceTerms.length) reasons.push("external-reference-language");
  const semanticSignalCount = [
    statement || acknowledgement || incident,
    customerImpact || impactScopeTerms.length,
    evidenceTerms.length,
    remediation || actionTerms.length || compensation || supportTerms.length,
    timeline || rootCauseTerms.length || legalCompliance || externalReferenceTerms.length || denial,
  ].filter(Boolean).length;
  const completeResponseNarrative = semanticSignalCount >= 5;
  if (completeResponseNarrative) reasons.push("official-owned-complete-response-narrative");
  const responseScore = Math.min(100,
    (statement ? 12 : 0)
    + (incident ? 16 : 0)
    + (apology ? 10 : 0)
    + (acknowledgement ? 10 : 0)
    + (remediation ? 14 : 0)
    + (compensation ? 12 : 0)
    + (customerImpact ? 12 : 0)
    + (timeline ? 8 : 0)
    + (legalCompliance ? 10 : 0)
    + (denial ? 8 : 0)
    + (evidenceTerms.length ? 10 : 0)
    + (impactScopeTerms.length ? 10 : 0)
    + (rootCauseTerms.length ? 10 : 0)
    + (actionTerms.length ? 10 : 0)
    + (supportTerms.length ? 8 : 0)
    + (externalReferenceTerms.length ? 8 : 0)
  );
  return {
    official_owned_statement_signal: statement ? 1 : 0,
    official_owned_incident_signal: incident ? 1 : 0,
    official_owned_apology_signal: apology ? 1 : 0,
    official_owned_acknowledgement_signal: acknowledgement ? 1 : 0,
    official_owned_remediation_signal: remediation ? 1 : 0,
    official_owned_compensation_signal: compensation ? 1 : 0,
    official_owned_customer_impact_signal: customerImpact ? 1 : 0,
    official_owned_timeline_signal: timeline ? 1 : 0,
    official_owned_legal_compliance_signal: legalCompliance ? 1 : 0,
    official_owned_denial_signal: denial ? 1 : 0,
    official_owned_evidence_reference_signal: evidenceTerms.length ? 1 : 0,
    official_owned_impact_scope_signal: impactScopeTerms.length ? 1 : 0,
    official_owned_root_cause_signal: rootCauseTerms.length ? 1 : 0,
    official_owned_action_commitment_signal: actionTerms.length ? 1 : 0,
    official_owned_support_faq_signal: supportTerms.length ? 1 : 0,
    official_owned_external_reference_signal: externalReferenceTerms.length ? 1 : 0,
    official_owned_evidence_terms: evidenceTerms,
    official_owned_impact_scope_terms: impactScopeTerms,
    official_owned_root_cause_terms: rootCauseTerms,
    official_owned_action_terms: actionTerms,
    official_owned_support_terms: supportTerms,
    official_owned_external_reference_terms: externalReferenceTerms,
    official_owned_response_score: responseScore,
    official_owned_response_bucket: officialOwnedResponseBucket(responseScore),
    official_owned_semantic_signal_count: semanticSignalCount,
    official_owned_complete_response_narrative_signal: completeResponseNarrative ? 1 : 0,
    official_owned_signal_count: reasons.length,
    official_owned_signal_reasons: reasons,
  };
}

function withOfficialOwnedResponseSignals(item = {}) {
  const signals = officialOwnedResponseSignals({
    title: item.title || "",
    content: item.content || item.aiSummary || "",
    url: item.url || "",
    sourceKind: item.metrics?.source_kind || "",
  });
  return {
    ...item,
    metrics: {
      ...(item.metrics || {}),
      ...signals,
    },
  };
}

function sameSiteCanonicalUrl(rawUrl = "", siteHost = "") {
  const url = absoluteUrl(rawUrl);
  if (!url || !siteHost || !sameSite(url, siteHost)) return "";
  return normalizeOfficialOwnedDedupeUrl(url);
}

function mergeOfficialOwnedEnrichment(item = {}, enrichment = {}) {
  if (!enrichment || typeof enrichment !== "object") return item;
  const metrics = enrichment.evidence?.metrics || {};
  const canonicalUrl = sameSiteCanonicalUrl(metrics.canonical_url || enrichment.evidence?.canonical_url || "", item.metrics?.official_owned_site_host || "");
  const articleExcerpt = cleanText(metrics.article_body_excerpt || "", 2400);
  const enrichedContent = articleExcerpt || cleanText(enrichment.content || "", 1200);
  const nextMetrics = {
    ...(item.metrics || {}),
    official_owned_detail_enriched: Boolean(enrichment.enriched || articleExcerpt || canonicalUrl),
    official_owned_detail_http_status: enrichment.http?.status || 0,
    official_owned_detail_etag: enrichment.http?.etag || "",
    official_owned_detail_last_modified: enrichment.http?.last_modified || "",
    official_owned_detail_canonical_url: canonicalUrl,
    official_owned_detail_og_url: sameSiteCanonicalUrl(metrics.og_url || enrichment.evidence?.og_url || "", item.metrics?.official_owned_site_host || ""),
    official_owned_detail_site_name: cleanText(metrics.site_name || enrichment.evidence?.site_name || "", 160),
    official_owned_detail_author: cleanText(metrics.author || enrichment.author || "", 160),
    official_owned_detail_published_time: cleanText(metrics.published_time || enrichment.published_at || "", 80),
    official_owned_detail_body_quality_score: Number(metrics.article_body_quality_score || 0),
    official_owned_detail_body_text_length: Number(metrics.article_body_text_length || 0),
    official_owned_detail_body_paragraph_count: Number(metrics.article_body_paragraph_count || 0),
    official_owned_detail_body_link_count: Number(metrics.article_body_link_count || 0),
    official_owned_detail_body_selector: cleanText(metrics.article_body_selector || "", 120),
    official_owned_detail_body_excerpt: articleExcerpt,
    official_owned_detail_jsonld_types: Array.isArray(metrics.jsonld_types) ? metrics.jsonld_types.slice(0, 20) : [],
    official_owned_detail_has_image: Boolean(metrics.has_image || enrichment.evidence?.image_url),
  };
  return withOfficialOwnedResponseSignals({
    ...item,
    url: canonicalUrl || item.url,
    content: enrichedContent && enrichedContent.length > String(item.content || "").length ? enrichedContent : item.content,
    author: cleanText(enrichment.author || metrics.author || "", 160) || item.author,
    publishedAt: normalizeDate(enrichment.published_at || metrics.published_time || "") || item.publishedAt,
    aiSummary: cleanText(enrichment.ai_summary || enrichment.content || "", 1200) || item.aiSummary,
    rawHtml: enrichment.raw_html || item.rawHtml || "",
    visualAssets: enrichment.visual_assets || item.visualAssets || [],
    metrics: nextMetrics,
  });
}

async function enrichOfficialOwnedItems(items = [], { proxyUrl = "", detailBudget = {}, seenDetailUrls = null } = {}) {
  const maxDetailPages = Number(detailBudget.maxDetailPagesPerKeyword || 0);
  if (!maxDetailPages || !items.length) return items;
  let remaining = maxDetailPages;
  const candidates = items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.url && item?.metrics?.official_owned_site_host && sameSite(item.url, item.metrics.official_owned_site_host))
    .filter(({ item }) => {
      const key = normalizeOfficialOwnedDedupeUrl(item.url);
      if (!key) return false;
      if (seenDetailUrls instanceof Set) {
        if (seenDetailUrls.has(key)) return false;
        seenDetailUrls.add(key);
      }
      return true;
    })
    .slice(0, remaining);
  if (!candidates.length) return items;
  remaining -= candidates.length;
  const enriched = [...items];
  const detailResults = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async ({ item, index }) => {
    const enrichment = await enrichSearchResultSummary(item, { proxyUrl });
    return { index, enrichment };
  });
  for (const result of detailResults) {
    if (!result || !Number.isInteger(result.index)) continue;
    enriched[result.index] = mergeOfficialOwnedEnrichment(enriched[result.index], result.enrichment);
  }
  return enriched;
}

function parseFeedItems(xml = "", keyword = "", { target = {}, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const text = String(xml || "");
  const blocks = [
    ...text.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map(match => match[0]);
  const rows = [];
  for (const block of blocks) {
    const url = linkValue(block, target.url);
    if (!url || (target.siteHost && !sameSite(url, target.siteHost))) continue;
    const title = cleanText(tagValue(block, "title"), 420);
    const content = cleanText([
      tagValue(block, "description"),
      tagValue(block, "summary"),
      tagValue(block, "content:encoded"),
      tagValue(block, "content"),
    ].filter(Boolean).join(" "), 2000);
    const publishedAt = normalizeDate(tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated")) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const combined = `${title} ${content} ${url}`;
    if (!target.matchedKeyword && !textMatchesKeyword(combined, keyword)) continue;
    if (!textMatchesKeyword(combined, keyword) && !textHasOfficialIntent(combined)) continue;
    rows.push(withOfficialOwnedResponseSignals({
      url,
      title: title || cleanText(url, 420),
      content: content || title || url,
      author: target.label || target.siteHost || "Official owned media",
      publishedAt,
      metrics: {
        source: "official_owned_media",
        source_family: "official",
        source_kind: "feed_item",
        source_weight_tier: "official-owned-media",
        official_owned_site_host: target.siteHost || "",
        official_owned_target_label: target.label || "",
        official_owned_target_url: target.url || "",
        official_owned_target_matched_keyword: Boolean(target.matchedKeyword),
        official_owned_discovery_mode: target.discoveryMode || "configured",
        official_owned_feed_item_count: blocks.length,
      },
    }));
    if (rows.length >= limit) break;
  }
  return rows;
}

function parseSitemapItems(xml = "", keyword = "", { target = {}, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const blocks = [...String(xml || "").matchAll(/<url\b[\s\S]*?<\/url>/gi)].map(match => match[0]);
  const rows = [];
  for (const block of blocks) {
    const url = absoluteUrl(tagValue(block, "loc"), target.url);
    if (!url || (target.siteHost && !sameSite(url, target.siteHost))) continue;
    const publishedAt = normalizeDate(tagValue(block, "lastmod")) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const title = cleanText(url.replace(/^https?:\/\//i, "").replace(/[/?#_-]+/g, " "), 420);
    const combined = `${title} ${url}`;
    if (!target.matchedKeyword && !textMatchesKeyword(combined, keyword)) continue;
    if (!textMatchesKeyword(combined, keyword) && !textHasOfficialIntent(combined)) continue;
    rows.push(withOfficialOwnedResponseSignals({
      url,
      title,
      content: title,
      author: target.label || target.siteHost || "Official owned media",
      publishedAt,
      metrics: {
        source: "official_owned_media",
        source_family: "official",
        source_kind: "sitemap_url",
        source_weight_tier: "official-owned-media",
        official_owned_site_host: target.siteHost || "",
        official_owned_target_label: target.label || "",
        official_owned_target_url: target.url || "",
        official_owned_target_matched_keyword: Boolean(target.matchedKeyword),
        official_owned_discovery_mode: target.discoveryMode || "configured",
        official_owned_sitemap_url_count: blocks.length,
      },
    }));
    if (rows.length >= limit) break;
  }
  return rows;
}

function htmlTitle(html = "") {
  return cleanText(String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "", 420);
}

function parseHtmlItems(html = "", keyword = "", { target = {}, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const text = String(html || "");
  const pageTitle = htmlTitle(text);
  const links = [...text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => {
      const url = absoluteUrl(match[1], target.url);
      return {
        url,
        title: cleanText(match[2], 420),
      };
    })
    .filter(link => link.url && (!target.siteHost || sameSite(link.url, target.siteHost)));
  const rows = [];
  const pageText = cleanText(text, 2200);
  if ((target.matchedKeyword || textMatchesKeyword(`${pageTitle} ${pageText} ${target.url}`, keyword)) && textHasOfficialIntent(`${pageTitle} ${pageText} ${target.url}`)) {
    rows.push(withOfficialOwnedResponseSignals({
      url: target.url,
      title: pageTitle || target.label || target.url,
      content: pageText || pageTitle || target.url,
      author: target.label || target.siteHost || "Official owned media",
      publishedAt: new Date().toISOString(),
      metrics: {
        source: "official_owned_media",
        source_family: "official",
        source_kind: "owned_page",
        source_weight_tier: "official-owned-media",
        official_owned_site_host: target.siteHost || "",
        official_owned_target_label: target.label || "",
        official_owned_target_url: target.url || "",
        official_owned_target_matched_keyword: Boolean(target.matchedKeyword),
        official_owned_discovery_mode: target.discoveryMode || "configured",
        official_owned_page_link_count: links.length,
      },
    }));
  }

  for (const link of links) {
    if (rows.length >= limit) break;
    const combined = `${link.title} ${link.url} ${pageTitle}`;
    if (!target.matchedKeyword && !textMatchesKeyword(combined, keyword)) continue;
    if (!textMatchesKeyword(combined, keyword) && !textHasOfficialIntent(combined)) continue;
    rows.push(withOfficialOwnedResponseSignals({
      url: link.url,
      title: link.title || cleanText(link.url, 420),
      content: cleanText(`${link.title} ${pageTitle} ${link.url}`, 1200),
      author: target.label || target.siteHost || "Official owned media",
      publishedAt: new Date().toISOString(),
      metrics: {
        source: "official_owned_media",
        source_family: "official",
        source_kind: "owned_link",
        source_weight_tier: "official-owned-media",
        official_owned_site_host: target.siteHost || "",
        official_owned_target_label: target.label || "",
        official_owned_target_url: target.url || "",
        official_owned_target_matched_keyword: Boolean(target.matchedKeyword),
        official_owned_discovery_mode: target.discoveryMode || "configured",
        official_owned_page_link_count: links.length,
      },
    }));
  }
  return rows.slice(0, limit).filter(item => isAfterSince(item.publishedAt, since));
}

function parseFeedDiscoveryTargets(html = "", keyword = "", { target = {}, limit = DEFAULT_MAX_DISCOVERED_FEEDS_PER_TARGET } = {}) {
  const text = String(html || "");
  const feedLinks = [
    ...[...text.matchAll(/<link\b[^>]*>/gi)].map(match => {
      const tag = match[0];
      const rel = attrValue(tag, "rel").toLowerCase();
      const type = attrValue(tag, "type").toLowerCase();
      const title = attrValue(tag, "title");
      const href = attrValue(tag, "href");
      const looksLikeFeed = /alternate|feed|rss|atom/.test(rel) || /rss|atom|feed/.test(type) || /rss|atom|feed/i.test(title);
      return looksLikeFeed ? { href, title } : null;
    }),
    ...[...text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(match => {
      const href = match[1];
      const title = cleanText(match[2], 180);
      const combined = `${href} ${title}`;
      return /(?:rss|atom|feed)(?:\.xml)?(?:[/?#]|$)/i.test(combined) ? { href, title } : null;
    }),
  ].filter(Boolean);
  const seen = new Set();
  const rows = [];
  for (const link of feedLinks) {
    const url = absoluteUrl(link.href, target.url);
    if (!url || (target.siteHost && !sameSite(url, target.siteHost))) continue;
    const key = normalizeOfficialOwnedDedupeUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const feedTarget = targetFromUrl(url, keyword, {
      label: link.title || target.label || target.siteHost || "Official feed",
      matchedKeyword: Boolean(target.matchedKeyword) || textMatchesKeyword(`${link.title || ""} ${url}`, keyword),
      discoveryMode: "owned-feed-discovery",
    });
    if (feedTarget) rows.push(feedTarget);
    if (rows.length >= limit) break;
  }
  return rows;
}

function parseOfficialOwnedDocument(body = "", keyword = "", { target = {}, contentType = "", limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const lowerUrl = String(target.url || "").toLowerCase();
  const lowerType = String(contentType || "").toLowerCase();
  if (/<rss\b|<feed\b|<item\b|<entry\b/i.test(body) || /rss|atom|xml/.test(lowerType) || /(?:feed|rss|atom)\.?(?:xml)?$/i.test(lowerUrl)) {
    if (/<urlset\b/i.test(body)) return parseSitemapItems(body, keyword, { target, limit, since });
    return parseFeedItems(body, keyword, { target, limit, since });
  }
  if (/<urlset\b/i.test(body) || /sitemap/i.test(lowerUrl)) return parseSitemapItems(body, keyword, { target, limit, since });
  return parseHtmlItems(body, keyword, { target, limit, since });
}

function targetFromUrl(rawUrl = "", keyword = "", extras = {}) {
  const url = absoluteUrl(rawUrl);
  if (!url) return null;
  const siteHost = hostnameFromText(url);
  if (!siteHost) return null;
  return {
    key: url,
    label: extras.label || extras.name || siteHost,
    url,
    siteHost,
    matchedKeyword: extras.matchedKeyword ?? textMatchesKeyword(`${extras.label || ""} ${extras.name || ""} ${url}`, keyword),
    discoveryMode: extras.discoveryMode || "configured",
  };
}

function directTargetFromUrl(rawUrl = "", keyword = "", extras = {}) {
  const target = targetFromUrl(rawUrl, keyword, {
    ...extras,
    matchedKeyword: true,
    discoveryMode: "direct-url",
  });
  if (!target) return null;
  return {
    ...target,
    label: extras.label || target.siteHost || "Official owned media direct URL",
  };
}

function normalizeTargets(targets = [], keyword = "", budget = normalizeBudget()) {
  const out = [];
  const configured = Array.isArray(targets) ? targets : [];
  for (const target of configured) {
    const rawUrl = typeof target === "string" ? target : target?.url || target?.homepage || target?.site || target?.domain;
    if (!rawUrl) continue;
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const item = targetFromUrl(normalizedUrl, keyword, {
      ...(typeof target === "object" ? target : {}),
      discoveryMode: "configured",
    });
    if (item) out.push(item);
  }

  const host = hostnameFromText(keyword);
  if (host) {
    out.push(targetFromUrl(`https://${host}`, keyword, { label: host, matchedKeyword: true, discoveryMode: "keyword-domain" }));
    for (const path of OWNED_MEDIA_PATH_HINTS) {
      out.push(targetFromUrl(`https://${host}${path}`, keyword, { label: host, matchedKeyword: true, discoveryMode: "keyword-domain-path" }));
    }
  }

  const seen = new Set();
  return out
    .filter(Boolean)
    .filter(target => {
      const key = normalizeOfficialOwnedDedupeUrl(target.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, budget.maxTargetsPerKeyword);
}

async function collectOfficialOwnedDirectUrlItems(directUrls = [], keyword = "", { proxyUrl = "", since = "" } = {}) {
  const normalizedDirectUrls = normalizeOfficialOwnedDirectUrls(directUrls);
  const rows = [];
  const failures = [];
  for (const directUrl of normalizedDirectUrls) {
    const target = directTargetFromUrl(directUrl, keyword);
    if (!target) continue;
    try {
      const res = await fetchPublicSource(directUrl, {
        headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ keyword, target: directUrl, message: httpFailure(res) });
        continue;
      }
      const body = await res.text();
      const items = parseOfficialOwnedDocument(body, keyword, {
        target,
        contentType: res.headers.get("content-type") || "",
        limit: 1,
        since,
      }).map(item => withOfficialOwnedResponseSignals({
        ...item,
        url: directUrl,
        metrics: {
          ...(item.metrics || {}),
          source_kind: "official_owned_direct_url",
          official_owned_direct_url: normalizeOfficialOwnedDedupeUrl(directUrl),
          official_owned_direct_url_recovery: true,
          official_owned_collection_mode: "direct-url",
          official_owned_discovery_mode: "direct-url",
        },
      }));
      rows.push(...items);
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: directUrl, message });
      console.warn(`[CRM/OfficialOwnedMedia] Direct URL fetch failed keyword=${keyword} target=${directUrl}: ${message}`);
    }
  }
  return { items: rows, failures };
}

async function insertOfficialOwnedItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = officialOwnedDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = assessRiskLevel({ title: item.title, content: item.content, sentiment });
    const result = insertSentimentItem({
      platform: "official_owned_media_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment,
      risk_level: risk,
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.aiSummary || item.content,
      raw_html: item.rawHtml || "",
      source_key: "officialOwnedMediaSources",
      evidence: {
        evidence_type: "official_owned_media_signal",
        metrics: {
          ...(item.metrics || {}),
          ...officialOwnedKeywordDiagnostics(item, keyword),
          official_owned_canonical_dedupe_url: dedupeKey,
          official_owned_search_scan_dedupe_key: dedupeKey,
          ...(attribution.length ? {
            failover_attribution: attribution,
            failover_from_sources: failoverFromSources,
          } : {}),
        },
      },
      source_type: "scraper",
      visual_assets: item.visualAssets || [],
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeOfficialOwnedMediaSources(keywords, { proxyUrl = "", budget = {}, deepBudget = {}, since = "", targets = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeOfficialOwnedDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const detailBudget = normalizeDetailBudget(deepBudget, budget);
  const seenItemUrls = new Set();
  const seenDetailUrls = new Set();
  const directKeyword = normalizedKeywords[0] || "official-owned-direct-url";
  let directInserted = 0;
  const directFailures = [];
  if (normalizedDirectUrls.length) {
    const direct = await collectOfficialOwnedDirectUrlItems(normalizedDirectUrls, directKeyword, { proxyUrl, since });
    directFailures.push(...direct.failures);
    const enrichedDirectItems = await enrichOfficialOwnedItems(direct.items, {
      proxyUrl,
      detailBudget: { maxDetailPagesPerKeyword: Math.max(1, detailBudget.maxDetailPagesPerKeyword || 0) },
      seenDetailUrls,
    });
    directInserted += await insertOfficialOwnedItems(enrichedDirectItems, {
      keyword: directKeyword,
      domainControls,
      contentControls,
      seenItemUrls,
      failoverAttribution,
    });
  }
  const results = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    const targetList = normalizeTargets(targets, keyword, normalizedBudget);
    const seenTargetUrls = new Set(targetList.map(target => normalizeOfficialOwnedDedupeUrl(target.url)).filter(Boolean));
    for (const target of targetList) {
      if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
      try {
        const res = await fetchPublicSource(target.url, {
          headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
          continue;
        }
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        const body = await res.text();
        let items = parseOfficialOwnedDocument(body, keyword, {
          target,
          contentType: res.headers.get("content-type") || "",
          limit: remaining,
          since,
        });
        const contentType = res.headers.get("content-type") || "";
        if (items.length < remaining && /html/i.test(contentType || target.url)) {
          const discoveredFeeds = parseFeedDiscoveryTargets(body, keyword, {
            target,
            limit: DEFAULT_MAX_DISCOVERED_FEEDS_PER_TARGET,
          }).filter(feedTarget => {
            const key = normalizeOfficialOwnedDedupeUrl(feedTarget.url);
            if (!key || seenTargetUrls.has(key)) return false;
            seenTargetUrls.add(key);
            return true;
          });
          for (const feedTarget of discoveredFeeds) {
            if (items.length >= remaining) break;
            try {
              const feedRes = await fetchPublicSource(feedTarget.url, {
                headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8" },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              }, proxyUrl);
              if (!feedRes.ok) {
                failures.push({ keyword, target: feedTarget.key || feedTarget.url, message: httpFailure(feedRes) });
                continue;
              }
              const feedBody = await feedRes.text();
              items = items.concat(parseOfficialOwnedDocument(feedBody, keyword, {
                target: feedTarget,
                contentType: feedRes.headers.get("content-type") || "",
                limit: remaining - items.length,
                since,
              }));
            } catch (err) {
              const message = formatSourceError(err, proxyUrl);
              failures.push({ keyword, target: feedTarget.key || feedTarget.url, message });
              console.warn(`[CRM/OfficialOwnedMedia] Feed discovery fetch failed keyword=${keyword} target=${feedTarget.key || feedTarget.url}: ${message}`);
            }
          }
        }
        const enrichedItems = await enrichOfficialOwnedItems(items, {
          proxyUrl,
          detailBudget: {
            maxDetailPagesPerKeyword: Math.max(0, detailBudget.maxDetailPagesPerKeyword - inserted),
          },
          seenDetailUrls,
        });
        inserted += await insertOfficialOwnedItems(enrichedItems, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, target: target.key || target.url, message });
        console.warn(`[CRM/OfficialOwnedMedia] 抓取失敗 keyword=${keyword} target=${target.key || target.url}: ${message}`);
      }
    }
    return { inserted, failures };
  });

  return scraperResult(
    directInserted + results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directFailures, ...results.flatMap(result => result?.failures || [])],
  );
}

export const __test__ = {
  OWNED_MEDIA_PATH_HINTS,
  OFFICIAL_INTENT_TERMS,
  DEFAULT_MAX_DISCOVERED_FEEDS_PER_TARGET,
  normalizeBudget,
  normalizeDetailBudget,
  normalizeOfficialOwnedKeywordText,
  hostnameFromText,
  keywordNeedles,
  textMatchesKeyword,
  textHasOfficialIntent,
  normalizeOfficialOwnedDedupeUrl,
  normalizeOfficialOwnedDirectUrls,
  officialOwnedDedupeKey,
  officialOwnedKeywordMatchSource,
  officialOwnedKeywordDiagnostics,
  officialOwnedResponseBucket,
  officialOwnedResponseSignals,
  withOfficialOwnedResponseSignals,
  mergeOfficialOwnedEnrichment,
  enrichOfficialOwnedItems,
  parseFeedItems,
  parseFeedDiscoveryTargets,
  parseSitemapItems,
  parseHtmlItems,
  parseOfficialOwnedDocument,
  directTargetFromUrl,
  collectOfficialOwnedDirectUrlItems,
  normalizeTargets,
};
