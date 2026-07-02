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
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(50, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(3, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function deepPagesPerKeyword(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") return 1;
  const value = Math.round(Number(deepBudget.maxPagesPerKeyword ?? deepBudget.max_pages_per_keyword ?? 1));
  return Math.max(0, Math.min(3, Number.isFinite(value) ? value : 1));
}

function normalizeBaiduUrl(rawUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded) return "";
  if (decoded.startsWith("//")) return `https:${decoded}`;
  try {
    const url = new URL(decoded);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "from"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeBaiduDedupeUrl(rawUrl = "") {
  const normalized = normalizeBaiduUrl(rawUrl);
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
      "fr",
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

function baiduSearchDedupeKey(item = {}) {
  return normalizeBaiduDedupeUrl(item?.url || "");
}

function normalizeBaiduKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function baiduKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeBaiduKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function baiduValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeBaiduKeywordText(value);
  return baiduKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeBaiduKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function baiduKeywordMatchSource(item = {}, keyword = "") {
  if (!baiduKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["public_search_engine", item.metrics?.public_search_engine],
    ["source_kind", item.metrics?.source_kind],
  ];
  for (const [field, value] of fields) {
    if (baiduValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function baiduKeywordDiagnostics(item = {}, keyword = "") {
  return {
    baidu_matched_keyword: stripTags(keyword, 160),
    baidu_keyword_match_source: baiduKeywordMatchSource(item, keyword),
  };
}

function baiduTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeBaiduKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeBaiduKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function baiduPublicSearchNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = baiduTermMatches(text, [
    "截图", "截圖", "录屏", "錄屏", "录音", "錄音", "证据", "證據", "凭证", "憑證", "文件", "发票", "發票",
    "订单", "訂單", "时间线", "時間線", "调查", "調查", "爆料", "实测", "實測", "proof", "evidence", "timeline",
  ]);
  const impactTerms = baiduTermMatches(text, [
    "退款", "拒退", "客服", "款项", "款項", "消费者", "消費者", "用户", "用戶", "受害", "损失", "損失",
    "风险", "風險", "诈骗", "詐騙", "翻车", "翻車", "炎上", "抵制", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = baiduTermMatches(text, [
    "官方回应", "官方回應", "官方声明", "官方聲明", "公开回应", "公開回應", "客服回复", "客服回覆",
    "客服回应", "客服回應", "道歉", "致歉", "澄清", "说明", "說明", "承诺", "承諾", "official response", "statement", "apology",
  ]);
  const propagationTerms = baiduTermMatches(text, [
    "扩散", "擴散", "延烧", "延燒", "发酵", "發酵", "热议", "熱議", "转发", "轉傳", "社群", "媒体报道", "媒體報導",
    "舆论", "輿論", "多平台", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = baiduTermMatches(text, [
    "投诉", "投訴", "客诉", "客訴", "退款", "拒退", "诈骗", "詐騙", "隐私", "隱私", "个人信息", "個資",
    "泄露", "外洩", "召回", "调查", "調查", "诉讼", "訴訟", "危机", "危機", "complaint", "refund", "scam", "breach", "crisis",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("baidu-evidence-language");
  if (impactTerms.length) reasons.push("baidu-impact-language");
  if (responseTerms.length) reasons.push("baidu-official-response-language");
  if (propagationTerms.length) reasons.push("baidu-propagation-language");
  if (crisisTerms.length) reasons.push("baidu-crisis-language");
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
  if (completeNarrative) reasons.push("baidu-complete-public-search-crisis-narrative");
  return {
    baidu_public_search_evidence_signal: evidenceTerms.length ? 1 : 0,
    baidu_public_search_impact_signal: impactTerms.length ? 1 : 0,
    baidu_public_search_official_response_signal: responseTerms.length ? 1 : 0,
    baidu_public_search_propagation_signal: propagationTerms.length ? 1 : 0,
    baidu_public_search_crisis_signal: crisisTerms.length ? 1 : 0,
    baidu_public_search_semantic_signal_count: semanticSignals,
    baidu_public_search_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    baidu_public_search_evidence_terms: evidenceTerms,
    baidu_public_search_impact_terms: impactTerms,
    baidu_public_search_response_terms: responseTerms,
    baidu_public_search_propagation_terms: propagationTerms,
    baidu_public_search_crisis_terms: crisisTerms,
    baidu_public_search_narrative_reasons: reasons,
  };
}

function parseBaiduDate(text = "", now = new Date()) {
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
  const siteMatch = String(block || "").match(/<span[^>]+class=["'][^"']*(?:c-color-gray|c-showurl|c-gap-right)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  return siteMatch ? stripTags(siteMatch[1], 80) : "";
}

function candidateBlocks(html = "") {
  const source = String(html || "");
  const blocks = [];
  const resultRegex = /<div[^>]+(?:class=["'][^"']*(?:result|c-container)[^"']*["'][^>]*|tpl=["'][^"']+["'][^>]*)>[\s\S]*?(?=<div[^>]+(?:class=["'][^"']*(?:result|c-container)[^"']*["'][^>]*|tpl=["'][^"']+["'][^>]*)>|<div[^>]+id=["']page["']|<\/body>|$)/gi;
  let match;
  while ((match = resultRegex.exec(source)) !== null) {
    if (/<h3[\s\S]*?<a/i.test(match[0])) blocks.push(match[0]);
  }
  if (blocks.length) return blocks;
  return [...source.matchAll(/<h3[^>]*>[\s\S]*?<a[^>]+href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>[\s\S]*?(?=<h3|$)/gi)].map(item => item[0]);
}

export function countBaiduRawResults(html = "") {
  return candidateBlocks(html).length;
}

export function parseBaiduSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "", sourceKind = "web" } = {}) {
  const now = new Date();
  const out = [];
  const seen = new Set();
  for (const block of candidateBlocks(html)) {
    const link = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)
      || block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = normalizeBaiduUrl(link[1]);
    const title = stripTags(link[2], 240);
    const blockText = stripTags(block, 1400);
    const content = blockText.replace(title, "").trim().slice(0, 900);
    if (!url || !title) continue;
    if (!baiduValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseBaiduDate(blockText, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: extractSourceName(block) || (sourceKind === "news" ? "百度新闻" : "百度搜索"),
      publishedAt,
      metrics: {
        public_search_engine: sourceKind === "news" ? "baidu_news" : "baidu_web",
        source_kind: sourceKind,
        collection_mode: "public_html_search",
      },
    });
    if (out.length >= Math.max(1, Math.min(50, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertBaiduItems(items, {
  keyword,
  proxyUrl = "",
  enrich = true,
  maxDeepPages = 0,
  platform = "baidu_search",
  evidenceType = "baidu_public_search_result",
  domainControls = {},
  contentControls = {},
  seenItemUrls = null,
}) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = baiduSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const shouldEnrich = enrich && deepPagesUsed < maxDeepPages && !/\/\/(?:www\.)?baidu\.com\/link\?/i.test(item.url);
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
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: enriched.evidence?.evidence_type || evidenceType,
        metrics: {
          ...evidenceMetrics,
          ...baiduKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: evidenceMetrics,
          }, keyword),
          baidu_canonical_dedupe_url: dedupeKey,
          baidu_search_scan_dedupe_key: dedupeKey,
          ...baiduPublicSearchNarrativeSignals({ ...item, content, author: enriched.author || item.author }),
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

async function scrapeBaiduPublicSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", searchKinds = ["web"], platform = "baidu_search", evidenceType = "baidu_public_search_result", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const kinds = (Array.isArray(searchKinds) && searchKinds.length ? searchKinds : ["web"])
    .map(kind => String(kind || "").trim().toLowerCase())
    .filter(kind => ["web", "news"].includes(kind));
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const pn = page * 10;
      const targets = (kinds.length ? kinds : ["web"]).map(kind => ({
        kind,
        url: kind === "news"
          ? `https://www.baidu.com/s?tn=news&word=${encodeURIComponent(keyword)}&pn=${pn}&ie=utf-8`
          : `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}&pn=${pn}&ie=utf-8`,
      }));
      for (const target of targets) {
        try {
          const res = await fetchPublicSource(target.url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, message: `${target.kind}: ${httpFailure(res)}` });
            continue;
          }
          const html = await res.text();
          const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
          if (remaining <= 0) break;
          const rawResultCount = countBaiduRawResults(html);
          const items = parseBaiduSearchResults(html, keyword, {
            limit: remaining,
            since,
            sourceKind: target.kind,
          }).map(item => ({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              baidu_search_page: page + 1,
              baidu_search_offset: pn,
              baidu_search_raw_result_count: rawResultCount,
            },
          }));
          const count = await insertBaiduItems(items, {
            keyword,
            proxyUrl,
            enrich,
            maxDeepPages,
            platform,
            evidenceType,
            domainControls,
            contentControls,
            seenItemUrls,
          });
          inserted += count;
          keywordInserted += count;
        } catch (err) {
          const message = formatSourceError(err, proxyUrl);
          failures.push({ keyword, message: `${target.kind}: ${message}` });
          console.warn(`[Sentiment/Baidu] 抓取失敗 keyword=${keyword} kind=${target.kind}: ${message}`);
        }
      }
    }
  }
  return scraperResult(inserted, failures);
}

export async function scrapeBaiduSearch(keywords, options = {}) {
  return scrapeBaiduPublicSearch(keywords, {
    ...options,
    searchKinds: options.searchKinds || ["web"],
    platform: options.platform || "baidu_search",
    evidenceType: options.evidenceType || "baidu_public_search_result",
  });
}

export async function scrapeBaiduNews(keywords, options = {}) {
  return scrapeBaiduPublicSearch(keywords, {
    ...options,
    searchKinds: options.searchKinds || ["news"],
    platform: options.platform || "baidu_news",
    evidenceType: options.evidenceType || "baidu_news_public_search_result",
  });
}

export const __test__ = {
  normalizeBudget,
  normalizeBaiduUrl,
  normalizeBaiduDedupeUrl,
  baiduSearchDedupeKey,
  normalizeBaiduKeywordText,
  baiduKeywordNeedles,
  baiduValueMatchesKeyword,
  baiduKeywordMatchSource,
  baiduKeywordDiagnostics,
  baiduPublicSearchNarrativeSignals,
  parseBaiduDate,
  parseBaiduSearchResults,
  countBaiduRawResults,
  scrapeBaiduPublicSearch,
};
