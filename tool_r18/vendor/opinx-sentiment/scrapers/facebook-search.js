import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_SEARCH_URL = "https://tw.search.yahoo.com/search";
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const SITE_SCOPES = ["facebook.com", "m.facebook.com", "fb.watch"];

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

function isFacebookHost(hostname = "") {
  const host = String(hostname || "").replace(/^www\./i, "").toLowerCase();
  return host === "facebook.com" || host === "m.facebook.com" || host === "fb.watch";
}

function normalizeFacebookUrl(value = "") {
  const raw = normalizeYahooRedirectUrl(value);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (!isFacebookHost(url.hostname)) return "";
    if (url.hostname.toLowerCase() === "m.facebook.com") url.hostname = "www.facebook.com";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "refsrc", "__tn__", "mibextid", "locale", "paipv", "rdid", "share_url"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeFacebookDedupeUrl(value = "") {
  const normalized = normalizeFacebookUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "refsrc", "__tn__", "mibextid", "locale", "paipv", "rdid", "share_url"]) {
      url.searchParams.delete(key);
    }
    if (url.hostname.toLowerCase() === "m.facebook.com") url.hostname = "www.facebook.com";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function facebookSearchDedupeKey(item = {}) {
  return normalizeFacebookDedupeUrl(item?.url || "");
}

function normalizeFacebookKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function facebookKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeFacebookKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function facebookValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeFacebookKeywordText(value);
  return facebookKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeFacebookKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function facebookKeywordMatchSource(item = {}, keyword = "") {
  if (!facebookKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["facebook_evidence_kind", item.metrics?.facebook_evidence_kind],
    ["search_scope", item.metrics?.search_scope],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (facebookValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function facebookKeywordDiagnostics(item = {}, keyword = "") {
  return {
    facebook_matched_keyword: stripTags(keyword, 160),
    facebook_keyword_match_source: facebookKeywordMatchSource(item, keyword),
  };
}

function isConcreteFacebookUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!isFacebookHost(parsed.hostname)) return false;
    if (parsed.hostname.replace(/^www\./i, "").toLowerCase() === "fb.watch") return parsed.pathname.split("/").filter(Boolean).length >= 1;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|hashtag|share|sharer|plugins|login|recover|help|privacy|policies|terms|settings|messages|notifications|events|marketplace|gaming|watch|stories|pages|people)$/i.test(segments[0])) return false;
    if (["posts", "videos", "photos", "permalink.php", "story.php", "photo.php", "reel"].some(part => segments.includes(part) || parsed.pathname.includes(part))) return true;
    if (parsed.searchParams.has("story_fbid") || parsed.searchParams.has("fbid") || parsed.searchParams.has("v")) return true;
    return false;
  } catch {
    return false;
  }
}

function facebookEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (parsed.hostname.replace(/^www\./i, "").toLowerCase() === "fb.watch") return "video";
    if (path.includes("/reel/")) return "reel";
    if (path.includes("/videos/") || parsed.searchParams.has("v")) return "video";
    if (path.includes("/photos/") || path.includes("photo.php") || parsed.searchParams.has("fbid")) return "photo";
    if (path.includes("/posts/") || path.includes("permalink.php") || path.includes("story.php") || parsed.searchParams.has("story_fbid")) return "post";
    return "public-page";
  } catch {
    return "";
  }
}

function facebookPostRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function facebookPostRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${keyword || ""}`.toLowerCase();
  const complaintTerms = [
    "complaint", "complaints", "refund", "chargeback", "dispute", "customer support",
    "support delay", "scam", "fraud", "boycott", "crisis", "apology", "backlash",
    "public response", "local crisis",
    "投訴", "投诉", "退款", "客服", "維權", "维权", "爭議", "争议", "危機", "危机",
    "道歉", "抵制", "爆料", "曝光",
  ].filter(term => text.includes(term.toLowerCase()));
  const shareTerms = [
    "share", "shares", "shared", "reshare", "reshares", "repost", "reposts",
    "comments", "comment thread", "reactions", "public post", "group post",
    "community discussion", "local group", "facebook group",
    "分享", "轉發", "转发", "留言", "评论", "評論", "社群", "群組", "群组",
  ].filter(term => text.includes(term.toLowerCase()));
  const evidenceTerms = [
    "screenshot", "receipt", "evidence", "proof", "archive", "timeline", "contract",
    "chat log", "order", "invoice", "documentation", "documents", "emails",
    "截图", "截圖", "证据", "證據", "凭证", "憑證", "合同", "聊天记录", "聊天紀錄", "订单", "訂單",
  ].filter(term => text.includes(term.toLowerCase()));
  const amplificationTerms = [
    "viral", "spreading", "trending", "widely shared", "public backlash",
    "media attention", "local crisis discussion", "local crisis amplification",
    "热议", "熱議", "扩散", "擴散", "发酵", "發酵", "传播", "傳播", "刷屏",
  ].filter(term => text.includes(term.toLowerCase()));
  const impactTerms = [
    "refund", "chargeback", "customer support delay", "support delay", "scam", "fraud",
    "boycott", "local crisis", "public backlash", "unsafe", "data breach", "account hacked",
    "退款", "拒付", "客服延遲", "客服延迟", "詐騙", "诈骗", "抵制", "危機", "危机", "不安全", "資料外洩", "数据泄露",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = [
    "apology", "public response", "official response", "business response", "company response",
    "resolved", "unresolved", "statement", "follow up", "refund issued",
    "道歉", "公開回應", "公开回应", "官方回應", "官方回应", "商家回應", "商家回应", "已解決", "已解决", "未解決", "未解决", "聲明", "声明",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.facebook_search_raw_result_count || 0));
  const evidenceKind = metrics.facebook_evidence_kind || facebookEvidenceKind(item.url);
  const isConcrete = isConcreteFacebookUrl(item.url || "");
  const isConversation = ["post", "video", "photo", "reel"].includes(evidenceKind);
  const isGroupPost = /\/groups\//i.test(item.url || "");
  const indexedScope = Boolean(metrics.search_scope);
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = facebookKeywordMatchSource(item, keyword) === "title";
  const reasons = [];
  if (isConcrete) reasons.push("concrete-facebook-url");
  if (isConversation) reasons.push(evidenceKind === "post" ? "facebook-post-url" : "facebook-media-url");
  if (isGroupPost) reasons.push("facebook-group-post-url");
  if (complaintTerms.length) reasons.push("complaint-language");
  if (shareTerms.length) reasons.push("share-discussion-language");
  if (evidenceTerms.length) reasons.push("evidence-language");
  if (amplificationTerms.length) reasons.push("amplification-language");
  if (impactTerms.length) reasons.push("impact-language");
  if (responseTerms.length) reasons.push("response-language");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (indexedScope) reasons.push("facebook-indexed-scope");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");

  const semanticSignalCount = [
    isConcrete,
    isConversation,
    isGroupPost,
    complaintTerms.length,
    shareTerms.length,
    evidenceTerms.length,
    amplificationTerms.length,
    impactTerms.length,
    responseTerms.length,
    rawResultCount > 1,
    indexedScope,
    enriched,
    titleMatch,
  ].filter(Boolean).length;
  const completeNarrative = isConcrete
    && isConversation
    && complaintTerms.length > 0
    && impactTerms.length > 0
    && evidenceTerms.length > 0
    && (shareTerms.length > 0 || amplificationTerms.length > 0)
    && semanticSignalCount >= 7;

  const score = Math.min(100, Math.max(0,
    (isConcrete ? 12 : 0)
    + (isConversation ? 12 : 0)
    + (isGroupPost ? 8 : 0)
    + (complaintTerms.length ? 24 : 0)
    + (shareTerms.length ? 14 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (amplificationTerms.length ? 14 : 0)
    + (impactTerms.length ? 10 : 0)
    + (responseTerms.length ? 8 : 0)
    + (completeNarrative ? 12 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (indexedScope ? 4 : 0)
    + (enriched ? 10 : 0)
    + (titleMatch ? 10 : 0)
  ));

  return {
    facebook_post_concrete_signal: isConcrete ? 1 : 0,
    facebook_post_conversation_signal: isConversation ? 1 : 0,
    facebook_post_group_signal: isGroupPost ? 1 : 0,
    facebook_post_complaint_signal: complaintTerms.length ? 1 : 0,
    facebook_post_share_discussion_signal: shareTerms.length ? 1 : 0,
    facebook_post_evidence_signal: evidenceTerms.length ? 1 : 0,
    facebook_post_amplification_signal: amplificationTerms.length ? 1 : 0,
    facebook_post_impact_signal: impactTerms.length ? 1 : 0,
    facebook_post_response_signal: responseTerms.length ? 1 : 0,
    facebook_post_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    facebook_post_complaint_terms: [...new Set(complaintTerms)].slice(0, 12),
    facebook_post_share_terms: [...new Set(shareTerms)].slice(0, 12),
    facebook_post_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    facebook_post_amplification_terms: [...new Set(amplificationTerms)].slice(0, 12),
    facebook_post_impact_terms: [...new Set(impactTerms)].slice(0, 12),
    facebook_post_response_terms: [...new Set(responseTerms)].slice(0, 12),
    facebook_post_index_scope_signal: indexedScope ? 1 : 0,
    facebook_post_deep_evidence_signal: enriched ? 1 : 0,
    facebook_post_semantic_signal_count: semanticSignalCount,
    facebook_post_risk_score: score,
    facebook_post_risk_bucket: facebookPostRiskBucket(score),
    facebook_post_risk_signal_count: [...new Set(reasons)].length,
    facebook_post_risk_reasons: [...new Set(reasons)],
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

function countFacebookRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeFacebookUrl(match[1]);
    if (url && isConcreteFacebookUrl(url)) count += 1;
  }
  return count;
}

export function parseFacebookSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const out = [];
  const seen = new Set();
  const now = new Date();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeFacebookUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || !isConcreteFacebookUrl(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!facebookValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseSearchDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: "Facebook 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_site_facebook",
        source_kind: "facebook_public_search",
        facebook_evidence_kind: facebookEvidenceKind(url),
        collection_mode: "site_facebook_public_search",
      },
    });
    out[out.length - 1].metrics = {
      ...(out[out.length - 1].metrics || {}),
      ...facebookPostRiskSignals(out[out.length - 1], keyword),
    };
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertFacebookItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = facebookSearchDedupeKey(item);
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
      ...facebookPostRiskSignals({
        ...item,
        content,
        author: enriched.author || item.author,
        metrics: evidenceMetrics,
      }, keyword),
    };
    const result = insertSentimentItem({
      platform: "facebook",
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
        evidence_type: enriched.evidence?.evidence_type || "facebook_public_search_result",
        metrics: {
          ...finalMetrics,
          ...facebookKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: finalMetrics,
          }, keyword),
          facebook_canonical_dedupe_url: dedupeKey,
          facebook_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeFacebookSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
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
          const rawResultCount = countFacebookRawResults(html);
          const items = parseFacebookSearchResults(html, keyword, {
            limit: remaining,
            since,
          }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              search_scope: scope,
              facebook_search_page: page + 1,
              facebook_search_start: start,
              facebook_search_raw_result_count: rawResultCount,
            },
          })).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              ...facebookPostRiskSignals(item, keyword),
            },
          }));
          const count = await insertFacebookItems(items, {
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
          console.warn(`[Sentiment/Facebook] 抓取失敗 keyword=${keyword} scope=${scope}: ${message}`);
        }
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  facebookSearchDedupeKey,
  facebookEvidenceKind,
  isConcreteFacebookUrl,
  normalizeBudget,
  normalizeFacebookDedupeUrl,
  normalizeFacebookUrl,
  parseFacebookSearchResults,
  countFacebookRawResults,
  normalizeFacebookKeywordText,
  facebookValueMatchesKeyword,
  facebookKeywordMatchSource,
  facebookKeywordDiagnostics,
  facebookPostRiskBucket,
  facebookPostRiskSignals,
};
