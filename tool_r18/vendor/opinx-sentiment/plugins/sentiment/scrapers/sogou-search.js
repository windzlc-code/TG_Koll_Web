import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;

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
    .replace(/<em[^>]*>/gi, "")
    .replace(/<\/em>/gi, "")
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

function normalizeSogouUrl(value = "") {
  const raw = decodeHtml(value || "").trim();
  if (!raw) return "";
  try {
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw.startsWith("/") ? `https://www.sogou.com${raw}` : raw;
    const url = new URL(absolute);
    const target = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("link");
    if (target && /^https?:\/\//i.test(target)) return normalizeSogouUrl(target);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "sogou.com" || host.endsWith(".sogou.com")) return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "from", "source"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeSogouDedupeUrl(value = "") {
  const normalized = normalizeSogouUrl(value);
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
      "from",
      "source",
      "src",
      "spm",
      "timestamp",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function sogouSearchDedupeKey(item = {}) {
  return normalizeSogouDedupeUrl(item?.url || "");
}

function normalizeSogouKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function sogouKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeSogouKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function sogouValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeSogouKeywordText(value);
  return sogouKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeSogouKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function sogouKeywordMatchSource(item = {}, keyword = "") {
  if (!sogouKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (sogouValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function sogouKeywordDiagnostics(item = {}, keyword = "") {
  return {
    sogou_matched_keyword: stripTags(keyword, 160),
    sogou_keyword_match_source: sogouKeywordMatchSource(item, keyword),
  };
}

function sogouTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeSogouKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeSogouKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function sogouPublicSearchNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = sogouTermMatches(text, [
    "截图", "截圖", "录屏", "錄屏", "录音", "錄音", "证据", "證據", "凭证", "憑證", "文件", "发票", "發票",
    "订单", "訂單", "时间线", "時間線", "调查", "調查", "爆料", "实测", "實測", "proof", "evidence", "timeline",
  ]);
  const impactTerms = sogouTermMatches(text, [
    "退款", "拒退", "客服", "款项", "款項", "消费者", "消費者", "用户", "用戶", "受害", "损失", "損失",
    "风险", "風險", "诈骗", "詐騙", "翻车", "翻車", "炎上", "抵制", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = sogouTermMatches(text, [
    "官方回应", "官方回應", "官方声明", "官方聲明", "公开回应", "公開回應", "客服回复", "客服回覆",
    "客服回应", "客服回應", "道歉", "致歉", "澄清", "说明", "說明", "承诺", "承諾", "official response", "statement", "apology",
  ]);
  const propagationTerms = sogouTermMatches(text, [
    "扩散", "擴散", "延烧", "延燒", "发酵", "發酵", "热议", "熱議", "转发", "轉傳", "社群", "媒体报道", "媒體報導",
    "舆论", "輿論", "多平台", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = sogouTermMatches(text, [
    "投诉", "投訴", "客诉", "客訴", "退款", "拒退", "诈骗", "詐騙", "隐私", "隱私", "个人信息", "個資",
    "泄露", "外洩", "召回", "调查", "調查", "诉讼", "訴訟", "危机", "危機", "complaint", "refund", "scam", "breach", "crisis",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("sogou-evidence-language");
  if (impactTerms.length) reasons.push("sogou-impact-language");
  if (responseTerms.length) reasons.push("sogou-official-response-language");
  if (propagationTerms.length) reasons.push("sogou-propagation-language");
  if (crisisTerms.length) reasons.push("sogou-crisis-language");
  const semanticSignals = [
    evidenceTerms.length,
    impactTerms.length,
    responseTerms.length,
    propagationTerms.length,
    crisisTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = evidenceTerms.length > 0
    && impactTerms.length > 0
    && responseTerms.length > 0
    && propagationTerms.length > 0
    && crisisTerms.length > 0
    && semanticSignals >= 5;
  if (completeNarrative) reasons.push("sogou-complete-public-search-crisis-narrative");
  return {
    sogou_public_search_evidence_signal: evidenceTerms.length ? 1 : 0,
    sogou_public_search_impact_signal: impactTerms.length ? 1 : 0,
    sogou_public_search_official_response_signal: responseTerms.length ? 1 : 0,
    sogou_public_search_propagation_signal: propagationTerms.length ? 1 : 0,
    sogou_public_search_crisis_signal: crisisTerms.length ? 1 : 0,
    sogou_public_search_semantic_signal_count: semanticSignals,
    sogou_public_search_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    sogou_public_search_evidence_terms: evidenceTerms,
    sogou_public_search_impact_terms: impactTerms,
    sogou_public_search_response_terms: responseTerms,
    sogou_public_search_propagation_terms: propagationTerms,
    sogou_public_search_crisis_terms: crisisTerms,
    sogou_public_search_narrative_reasons: reasons,
  };
}

function parseSogouDate(text = "", now = new Date()) {
  const source = String(text || "");
  const absolute = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(source);
  if (absolute) return new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), 12, 0, 0);
  const monthDay = /(\d{1,2})月(\d{1,2})日/.exec(source);
  if (monthDay) {
    const candidate = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]), 12, 0, 0);
    if (candidate.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) candidate.setFullYear(now.getFullYear() - 1);
    return candidate;
  }
  const relative = /(\d+)\s*(分钟|分鐘|小时|小時|天|日)前/.exec(source);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isFinite(amount)) return null;
    if (/分钟|分鐘/.test(relative[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/小时|小時/.test(relative[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  if (/昨天/.test(source)) return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return null;
}

function extractSourceName(block = "") {
  const sourceMatch = String(block || "").match(/(?:来源|來源)[:：]\s*([^<\s]{2,40})/i);
  if (sourceMatch?.[1]) return stripTags(sourceMatch[1], 80);
  const citeMatch = String(block || "").match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
  if (citeMatch?.[1]) return stripTags(citeMatch[1], 80).split(/\s+/)[0] || "";
  return "";
}

function candidateBlocks(html = "") {
  const source = String(html || "");
  const blocks = [];
  const blockRegex = /<(?:div|li)[^>]+class=["'][^"']*(?:vrwrap|rb|result|results)[^"']*["'][^>]*>[\s\S]*?(?=<(?:div|li)[^>]+class=["'][^"']*(?:vrwrap|rb|result|results)[^"']*["']|<div[^>]+id=["']pagebar["']|<\/body>|$)/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    if (/<a[^>]+href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/i.test(match[0])) blocks.push(match[0]);
  }
  if (blocks.length) return blocks;
  return [...source.matchAll(/<h3[^>]*>[\s\S]*?<a[^>]+href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>[\s\S]*?(?=<h3|$)/gi)].map(item => item[0]);
}

function countSogouRawResults(html = "") {
  return candidateBlocks(html).length;
}

export function parseSogouSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const now = new Date();
  const out = [];
  const seen = new Set();
  for (const block of candidateBlocks(html)) {
    const link = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)
      || block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = normalizeSogouUrl(link[1]);
    const title = stripTags(link[2], 240);
    const blockText = stripTags(block, 1400);
    const content = blockText.replace(title, "").trim().slice(0, 900);
    if (!url || !title) continue;
    if (!sogouValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseSogouDate(blockText, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: extractSourceName(block) || "搜狗公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "sogou_web",
        source_kind: "sogou_public_search",
        collection_mode: "public_html_search",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertSogouItems(items, {
  keyword,
  proxyUrl = "",
  enrich = true,
  maxDeepPages = 0,
  domainControls = {},
  contentControls = {},
  seenItemUrls = null,
}) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = sogouSearchDedupeKey(item);
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
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const result = insertSentimentItem({
      platform: "sogou_search",
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
        evidence_type: enriched.evidence?.evidence_type || "sogou_public_search_result",
        metrics: {
          ...evidenceMetrics,
          ...sogouKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: evidenceMetrics,
          }, keyword),
          sogou_canonical_dedupe_url: dedupeKey,
          sogou_search_scan_dedupe_key: dedupeKey,
          ...sogouPublicSearchNarrativeSignals({ ...item, content, author: enriched.author || item.author }),
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

export async function scrapeSogouSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 1; page <= maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const url = `https://www.sogou.com/web?query=${encodeURIComponent(keyword)}&page=${page}&ie=utf8`;
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const rawResultCount = countSogouRawResults(html);
        const items = parseSogouSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            sogou_search_page: page,
            sogou_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertSogouItems(items, {
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
        failures.push({ keyword, message });
        console.warn(`[Sentiment/Sogou] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  normalizeBudget,
  normalizeSogouUrl,
  normalizeSogouDedupeUrl,
  sogouSearchDedupeKey,
  normalizeSogouKeywordText,
  sogouKeywordNeedles,
  sogouValueMatchesKeyword,
  sogouKeywordMatchSource,
  sogouKeywordDiagnostics,
  sogouPublicSearchNarrativeSignals,
  parseSogouDate,
  parseSogouSearchResults,
  countSogouRawResults,
};
