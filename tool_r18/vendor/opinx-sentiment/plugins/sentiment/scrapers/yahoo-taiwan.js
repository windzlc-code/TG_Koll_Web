/**
 * scrapers/yahoo-taiwan.js — Yahoo 奇摩台灣搜尋爬蟲
 *
 * 使用 Yahoo 奇摩台灣站作為本地化公開搜尋來源，不依賴 Bing。
 */

import { isRecentDate, isTaiwanRelatedText } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_TAIWAN_SEARCH_URL = "https://tw.search.yahoo.com/search";
const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 3;
const DEFAULT_MAX_RESULTS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ensp;|&#8194;/g, " ")
    .replace(/&emsp;|&#8195;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeHtml(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeYahooUrl(rawUrl) {
  if (!rawUrl) return "";
  const decoded = decodeHtml(rawUrl);
  try {
    const url = new URL(decoded);
    if (/r\.search\.yahoo\.com$/i.test(url.hostname)) {
      const ru = /\/RU=([^/]+)/.exec(url.pathname);
      if (ru?.[1]) return decodeURIComponent(ru[1]);
      const direct = url.searchParams.get("u") || url.searchParams.get("url");
      if (direct) return decodeURIComponent(direct);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return decoded;
  }
}

function parseYahooDate(text, now = new Date()) {
  const source = String(text || "");
  if (/昨天/.test(source)) return new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const absolute = /(\d{4})[/-年](\d{1,2})[/-月](\d{1,2})日?/.exec(source);
  if (absolute) {
    return new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), 12, 0, 0);
  }

  const monthDay = /(\d{1,2})月(\d{1,2})日/.exec(source);
  if (monthDay) {
    const candidate = new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]), 12, 0, 0);
    if (candidate.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) candidate.setFullYear(now.getFullYear() - 1);
    return candidate;
  }

  const relative = /(\d+)\s*(分鐘|小時|天|日)前/.exec(source);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = relative[2];
    if (unit === "分鐘") return new Date(now.getTime() - amount * 60 * 1000);
    if (unit === "小時") return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }

  return null;
}

function urlHostMatches(url, allowedHostPattern) {
  if (!allowedHostPattern) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowedHostPattern.test(hostname);
  } catch {
    return false;
  }
}

function yahooTaiwanDedupeKey(item = {}) {
  return normalizeYahooUrl(item.url || "");
}

function normalizeYahooTaiwanKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function yahooTaiwanKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword).slice(0, 160);
  const compact = normalizeYahooTaiwanKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function yahooTaiwanValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value).slice(0, 1600).toLowerCase();
  const compact = normalizeYahooTaiwanKeywordText(value);
  return yahooTaiwanKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeYahooTaiwanKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function yahooTaiwanKeywordMatchSource(item = {}, keyword = "", author = "") {
  if (!yahooTaiwanKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", author || item.author],
    ["url", item.url],
  ];
  const match = fields.find(([, value]) => yahooTaiwanValueMatchesKeyword(value, keyword));
  return match?.[0] || "context";
}

function yahooTaiwanKeywordDiagnostics(item = {}, keyword = "", author = "") {
  return {
    yahoo_taiwan_matched_keyword: stripTags(keyword).slice(0, 160),
    yahoo_taiwan_keyword_match_source: yahooTaiwanKeywordMatchSource(item, keyword, author),
  };
}

function yahooTaiwanTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeYahooTaiwanKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeYahooTaiwanKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function yahooTaiwanMediaNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = yahooTaiwanTermMatches(text, [
    "截圖", "截图", "錄影", "录像", "證據", "证据", "憑證", "凭证", "文件", "發票", "发票",
    "訂單", "订单", "時間線", "时间线", "調查", "调查", "爆料", "實測", "实测", "proof", "evidence", "timeline",
  ]);
  const impactTerms = yahooTaiwanTermMatches(text, [
    "退款", "拒退", "客服", "款項", "款项", "消費者", "消费者", "用戶", "用户", "受害", "損失", "损失",
    "風險", "风险", "詐騙", "诈骗", "炎上", "抵制", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = yahooTaiwanTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回覆", "客服回复",
    "客服回應", "客服回应", "道歉", "致歉", "澄清", "說明", "说明", "承諾", "承诺", "official response", "statement", "apology",
  ]);
  const propagationTerms = yahooTaiwanTermMatches(text, [
    "擴散", "扩散", "延燒", "延烧", "發酵", "发酵", "熱議", "热议", "轉傳", "转传", "社群", "社群平台",
    "媒體報導", "媒体报道", "輿論", "舆论", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = yahooTaiwanTermMatches(text, [
    "投訴", "投诉", "客訴", "客诉", "退款", "拒退", "詐騙", "诈骗", "資安", "资安", "外洩", "泄露",
    "召回", "調查", "调查", "訴訟", "诉讼", "危機", "危机", "complaint", "refund", "scam", "breach", "crisis",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("yahoo-taiwan-evidence-language");
  if (impactTerms.length) reasons.push("yahoo-taiwan-impact-language");
  if (responseTerms.length) reasons.push("yahoo-taiwan-official-response-language");
  if (propagationTerms.length) reasons.push("yahoo-taiwan-propagation-language");
  if (crisisTerms.length) reasons.push("yahoo-taiwan-crisis-language");
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
  if (completeNarrative) reasons.push("yahoo-taiwan-complete-media-crisis-narrative");
  return {
    yahoo_taiwan_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    yahoo_taiwan_media_impact_signal: impactTerms.length ? 1 : 0,
    yahoo_taiwan_media_official_response_signal: responseTerms.length ? 1 : 0,
    yahoo_taiwan_media_propagation_signal: propagationTerms.length ? 1 : 0,
    yahoo_taiwan_media_crisis_signal: crisisTerms.length ? 1 : 0,
    yahoo_taiwan_media_semantic_signal_count: semanticSignals,
    yahoo_taiwan_complete_media_crisis_narrative_signal: completeNarrative ? 1 : 0,
    yahoo_taiwan_media_evidence_terms: evidenceTerms,
    yahoo_taiwan_media_impact_terms: impactTerms,
    yahoo_taiwan_media_response_terms: responseTerms,
    yahoo_taiwan_media_propagation_terms: propagationTerms,
    yahoo_taiwan_media_crisis_terms: crisisTerms,
    yahoo_taiwan_media_narrative_reasons: reasons,
  };
}

function budgetItemsPerKeyword(budget = {}) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_RESULTS_PER_KEYWORD));
  return Math.max(1, Math.min(50, Number.isFinite(value) ? value : DEFAULT_MAX_RESULTS_PER_KEYWORD));
}

function searchPagesPerKeyword(budget = {}) {
  const value = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return Math.max(1, Math.min(3, Number.isFinite(value) ? value : DEFAULT_MAX_PAGES_PER_KEYWORD));
}

function deepPagesPerKeyword(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") return 1;
  const value = Math.round(Number(deepBudget.maxPagesPerKeyword ?? deepBudget.max_pages_per_keyword ?? 1));
  return Math.max(0, Math.min(5, Number.isFinite(value) ? value : 1));
}

function parseYahooResults(html, keyword, { requireTaiwan = true, allowedHostPattern = null, resultUrlFilter = null, maxItems = DEFAULT_MAX_RESULTS_PER_KEYWORD } = {}) {
  const results = [];
  const source = String(html || "");
  const now = new Date();
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  let match;

  while ((match = headingRegex.exec(source)) !== null) {
    const title = stripTags(match[2]);
    const url = normalizeYahooUrl(match[1]);
    if (!title || !url || /\/\/(?:tw\.)?search\.yahoo\.com\//i.test(url)) continue;
    if (!urlHostMatches(url, allowedHostPattern)) continue;
    if (typeof resultUrlFilter === "function" && !resultUrlFilter(url)) continue;

    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block).slice(0, 500);
    if (keyword && !yahooTaiwanValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    if (requireTaiwan && !isTaiwanRelatedText(title, content, url)) continue;

    const publishedAt = parseYahooDate(`${title} ${content}`, now) || now;
    if (!isRecentDate(publishedAt, now)) continue;

    results.push({ url, title, content, publishedAt: publishedAt.toISOString() });
    if (results.length >= maxItems) break;
  }

  return results;
}

function countYahooTaiwanRawResults(html, { allowedHostPattern = null, resultUrlFilter = null } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeYahooUrl(match[1]);
    if (!url || /\/\/(?:tw\.)?search\.yahoo\.com\//i.test(url)) continue;
    if (!urlHostMatches(url, allowedHostPattern)) continue;
    if (typeof resultUrlFilter === "function" && !resultUrlFilter(url)) continue;
    count += 1;
  }
  return count;
}

export async function scrapeYahooSearch(
  keywords,
  {
    proxyUrl = "",
    enrich = true,
    platform = "yahoo_taiwan",
    author = "Yahoo奇摩搜尋",
    siteQuery = "",
    querySuffix = "台灣",
    requireTaiwan = true,
    allowedHostPattern = null,
    resultUrlFilter = null,
    logPrefix = "YahooTaiwan",
    budget = {},
    deepBudget = null,
    domainControls = {},
    contentControls = {},
    metricsEnhancer = null,
  } = {},
) {
  if (!keywords.length) return scraperResult(0);
  const maxItems = budgetItemsPerKeyword(budget);
  const maxPages = searchPagesPerKeyword(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();

  const results = await mapWithConcurrency(keywords, KEYWORD_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    let deepPagesUsed = 0;
    for (let page = 0; page < maxPages && inserted < maxItems; page += 1) {
      try {
        const query = [keyword, querySuffix, siteQuery].filter(Boolean).join(" ");
        const searchStart = page * 10 + 1;
        const url = `${YAHOO_TAIWAN_SEARCH_URL}?p=${encodeURIComponent(query)}&fr=yfp-search-sb&fr2=time&ei=UTF-8&vc=&fp=1&b=${searchStart}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }

        const html = await res.text();
        const rawResultCount = countYahooTaiwanRawResults(html, { allowedHostPattern, resultUrlFilter });
        const items = parseYahooResults(html, keyword, {
          requireTaiwan,
          allowedHostPattern,
          resultUrlFilter,
          maxItems: Math.max(1, maxItems - inserted),
        }).map(item => ({
          ...item,
          metrics: {
            yahoo_taiwan_search_page: page + 1,
            yahoo_taiwan_search_start: searchStart,
            yahoo_taiwan_search_raw_result_count: rawResultCount,
          },
        }));

        for (const item of items) {
          const dedupeKey = yahooTaiwanDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const shouldEnrich = enrich && deepPagesUsed < maxDeepPages;
          const enriched = shouldEnrich
            ? await enrichSearchResultSummary(item, { proxyUrl })
            : { content: item.content, ai_summary: item.content, enriched: false };
          if (shouldEnrich) deepPagesUsed += 1;
          const content = enriched.content || item.content;
          const sentiment = analyzeSentiment(`${item.title} ${content}`);
          const evidenceMetrics = {
            ...(item.metrics || {}),
            ...(enriched.evidence?.metrics || {}),
          };
          const itemAuthor = enriched.author || author;
          const enhancedMetrics = typeof metricsEnhancer === "function"
            ? metricsEnhancer({
              item: { ...item, content, author: itemAuthor },
              keyword,
              platform,
              author: itemAuthor,
              metrics: evidenceMetrics,
              siteQuery,
              querySuffix,
            }) || {}
            : {};
          const result = insertSentimentItem({
            platform,
            url: item.url,
            title: item.title,
            content,
            author: itemAuthor,
            sentiment,
            risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
            keyword,
            keywords: [keyword],
            published_at: enriched.published_at || item.publishedAt,
            ai_summary: enriched.ai_summary,
            raw_html: enriched.raw_html || "",
            evidence: {
              ...(enriched.evidence || {}),
              source_key: "yahooTaiwan",
              evidence_type: enriched.evidence?.evidence_type || "yahoo_taiwan_search_result",
              metrics: {
                ...evidenceMetrics,
                ...yahooTaiwanKeywordDiagnostics({ ...item, content, author: itemAuthor, metrics: evidenceMetrics }, keyword, itemAuthor),
                yahoo_taiwan_canonical_dedupe_url: dedupeKey,
                yahoo_taiwan_search_scan_dedupe_key: dedupeKey,
                ...yahooTaiwanMediaNarrativeSignals({ ...item, content, author: itemAuthor }),
                ...enhancedMetrics,
              },
            },
            visual_assets: enriched.visual_assets || [],
            source_type: "scraper",
            domainControls,
            contentControls,
          });
          if (result.inserted) inserted++;
        }
        if (!rawResultCount) break;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, message });
        console.warn(`[CRM/${logPrefix}] 爬取失敗 keyword=${keyword}: ${message}`);
      }
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeYahooTaiwan(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, domainControls = {}, contentControls = {} } = {}) {
  return scrapeYahooSearch(keywords, { proxyUrl, enrich, budget, deepBudget, domainControls, contentControls });
}

export const __test__ = {
  parseYahooResults,
  budgetItemsPerKeyword,
  searchPagesPerKeyword,
  deepPagesPerKeyword,
  countYahooTaiwanRawResults,
  normalizeYahooUrl,
  normalizeYahooTaiwanKeywordText,
  yahooTaiwanValueMatchesKeyword,
  yahooTaiwanDedupeKey,
  yahooTaiwanKeywordMatchSource,
  yahooTaiwanKeywordDiagnostics,
  yahooTaiwanMediaNarrativeSignals,
};
