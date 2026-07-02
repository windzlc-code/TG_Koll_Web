/**
 * scrapers/yahoo-japan-news.js — Yahoo Japan 公開新聞搜索
 *
 * Uses Yahoo Japan public search as a free regional discovery surface.
 */

import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YAHOO_JAPAN_SEARCH_URL = "https://search.yahoo.co.jp/search";
const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const JAPAN_CONTEXT_TERMS = ["日本", "Japan", "ニュース", "news", "炎上", "苦情", "返金", "詐欺", "悪評", "個人情報", "リコール"];

function decodeHtml(text = "") {
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

function stripTags(html = "", max = 1200) {
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

function normalizeYahooJapanUrl(rawUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded) return "";
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
    if (/r\.search\.yahoo\.co\.jp$/i.test(url.hostname) || /r\.search\.yahoo\.com$/i.test(url.hostname)) {
      const ru = /\/RU=([^/]+)/.exec(url.pathname);
      if (ru?.[1]) return normalizeYahooJapanUrl(decodeURIComponent(ru[1]));
      const direct = url.searchParams.get("u") || url.searchParams.get("url");
      if (direct) return normalizeYahooJapanUrl(decodeURIComponent(direct));
    }
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fr", "fr2", "ei"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function yahooJapanNewsDedupeKey(item = {}) {
  return normalizeYahooJapanUrl(item.url || "");
}

function normalizeYahooJapanNewsKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function yahooJapanNewsKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeYahooJapanNewsKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function yahooJapanNewsValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeYahooJapanNewsKeywordText(value);
  return yahooJapanNewsKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeYahooJapanNewsKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function yahooJapanNewsKeywordMatchSource(item = {}, keyword = "") {
  if (!yahooJapanNewsKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
  ];
  const match = fields.find(([, value]) => yahooJapanNewsValueMatchesKeyword(value, keyword));
  return match?.[0] || "context";
}

function yahooJapanNewsKeywordDiagnostics(item = {}, keyword = "") {
  return {
    yahoo_japan_news_matched_keyword: stripTags(keyword, 160),
    yahoo_japan_news_keyword_match_source: yahooJapanNewsKeywordMatchSource(item, keyword),
  };
}

function yahooJapanNewsTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeYahooJapanNewsKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeYahooJapanNewsKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function yahooJapanNewsMediaNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = yahooJapanNewsTermMatches(text, [
    "スクリーンショット", "画像", "録音", "録画", "証拠", "証明", "領収書", "請求書", "注文番号", "時系列",
    "調査", "告発", "資料", "screenshot", "proof", "evidence", "receipt", "timeline", "investigation",
  ]);
  const impactTerms = yahooJapanNewsTermMatches(text, [
    "返金", "返金拒否", "顧客対応", "サポート", "消費者", "利用者", "被害", "損失", "リスク", "詐欺",
    "炎上", "不買", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = yahooJapanNewsTermMatches(text, [
    "公式発表", "公式声明", "公式回答", "謝罪", "説明", "釈明", "対応", "顧客対応", "問い合わせ窓口",
    "改善策", "再発防止", "official response", "statement", "apology", "clarification",
  ]);
  const propagationTerms = yahooJapanNewsTermMatches(text, [
    "拡散", "炎上", "話題", "波紋", "SNS", "ネット上", "報道", "メディア", "口コミ", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = yahooJapanNewsTermMatches(text, [
    "苦情", "クレーム", "返金", "詐欺", "個人情報", "情報漏えい", "漏洩", "リコール", "調査", "訴訟",
    "危機", "炎上", "complaint", "refund", "scam", "breach", "recall", "lawsuit", "crisis",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("yahoo-japan-news-evidence-language");
  if (impactTerms.length) reasons.push("yahoo-japan-news-impact-language");
  if (responseTerms.length) reasons.push("yahoo-japan-news-official-response-language");
  if (propagationTerms.length) reasons.push("yahoo-japan-news-propagation-language");
  if (crisisTerms.length) reasons.push("yahoo-japan-news-crisis-language");
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
  if (completeNarrative) reasons.push("yahoo-japan-news-complete-media-crisis-narrative");
  return {
    yahoo_japan_news_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    yahoo_japan_news_media_impact_signal: impactTerms.length ? 1 : 0,
    yahoo_japan_news_media_official_response_signal: responseTerms.length ? 1 : 0,
    yahoo_japan_news_media_propagation_signal: propagationTerms.length ? 1 : 0,
    yahoo_japan_news_media_crisis_signal: crisisTerms.length ? 1 : 0,
    yahoo_japan_news_media_semantic_signal_count: semanticSignals,
    yahoo_japan_news_complete_media_crisis_narrative_signal: completeNarrative ? 1 : 0,
    yahoo_japan_news_media_evidence_terms: evidenceTerms,
    yahoo_japan_news_media_impact_terms: impactTerms,
    yahoo_japan_news_media_response_terms: responseTerms,
    yahoo_japan_news_media_propagation_terms: propagationTerms,
    yahoo_japan_news_media_crisis_terms: crisisTerms,
    yahoo_japan_news_media_narrative_reasons: reasons,
  };
}

function parseYahooJapanDate(text = "", now = new Date()) {
  const source = String(text || "");
  const absoluteJa = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(source);
  if (absoluteJa) return new Date(Number(absoluteJa[1]), Number(absoluteJa[2]) - 1, Number(absoluteJa[3]), 12, 0, 0);
  const monthDayJa = /(\d{1,2})月(\d{1,2})日/.exec(source);
  if (monthDayJa) {
    const candidate = new Date(now.getFullYear(), Number(monthDayJa[1]) - 1, Number(monthDayJa[2]), 12, 0, 0);
    if (candidate.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) candidate.setFullYear(now.getFullYear() - 1);
    return candidate;
  }
  const absoluteEn = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(source);
  if (absoluteEn) return new Date(`${absoluteEn[1]} ${absoluteEn[2]}, ${absoluteEn[3]} 12:00:00`);
  const relativeJa = /(\d+)\s*(分|時間|日)前/.exec(source);
  if (relativeJa) {
    const amount = Number(relativeJa[1]);
    if (!Number.isFinite(amount)) return null;
    if (relativeJa[2] === "分") return new Date(now.getTime() - amount * 60 * 1000);
    if (relativeJa[2] === "時間") return new Date(now.getTime() - amount * 60 * 60 * 1000);
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

function shouldKeepYahooJapanResult({ title = "", content = "", keyword = "" }) {
  const text = `${title} ${content}`.toLowerCase();
  if (keyword && !yahooJapanNewsValueMatchesKeyword(`${title} ${content}`, keyword)) return false;
  return JAPAN_CONTEXT_TERMS.some(term => text.includes(term.toLowerCase())) || /[\u3040-\u30ff]/.test(text);
}

function countYahooJapanNewsRawResults(html = "") {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h3>/gi;
  let count = 0;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeYahooJapanUrl(match[1]);
    if (url && !/\/\/search\.yahoo\.co\.jp\//i.test(url)) count += 1;
  }
  return count;
}

export function parseYahooJapanNewsResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const headingRegex = /<h3[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  const now = new Date();
  const out = [];
  const seen = new Set();
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    const url = normalizeYahooJapanUrl(match[1]);
    const title = stripTags(match[2], 240);
    if (!url || !title || /\/\/search\.yahoo\.co\.jp\//i.test(url)) continue;
    const nextStart = headingRegex.lastIndex;
    const nextHeading = source.slice(nextStart).search(/<h3[^>]*>/i);
    const block = source.slice(nextStart, nextHeading >= 0 ? nextStart + nextHeading : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!shouldKeepYahooJapanResult({ title, content, keyword })) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseYahooJapanDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: "Yahoo Japan 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yahoo_japan_search",
        source_kind: "yahoo_japan_public_news_search",
        news_region: "japan",
        news_language: "ja-JP",
        collection_mode: "site_yahoo_japan_public_search",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertYahooJapanNewsItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = yahooJapanNewsDedupeKey(item);
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
    const itemAuthor = enriched.author || item.author;
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const result = insertSentimentItem({
      platform: "yahoo_japan_news",
      url: item.url,
      title: item.title,
      content,
      author: itemAuthor,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
      keyword,
      keywords: [keyword],
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary || content,
      raw_html: enriched.raw_html || "",
      evidence: {
        ...(enriched.evidence || {}),
        source_key: "yahooJapanNews",
        evidence_type: enriched.evidence?.evidence_type || "yahoo_japan_news_result",
        metrics: {
          ...evidenceMetrics,
          ...yahooJapanNewsKeywordDiagnostics({ ...item, content, author: itemAuthor, metrics: evidenceMetrics }, keyword),
          yahoo_japan_news_canonical_dedupe_url: dedupeKey,
          yahoo_japan_news_search_scan_dedupe_key: dedupeKey,
          ...yahooJapanNewsMediaNarrativeSignals({ ...item, content, author: itemAuthor }),
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

export async function scrapeYahooJapanNews(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `${keyword} (${JAPAN_CONTEXT_TERMS.slice(0, 6).join(" OR ")})`;
      const url = `${YAHOO_JAPAN_SEARCH_URL}?p=${encodeURIComponent(query)}&ei=UTF-8&fr=top_ga1_sa&b=${page * 10 + 1}`;
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8,zh-TW;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const searchStart = page * 10 + 1;
        const rawResultCount = countYahooJapanNewsRawResults(html);
        const items = parseYahooJapanNewsResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            yahoo_japan_news_search_page: page + 1,
            yahoo_japan_news_search_start: searchStart,
            yahoo_japan_news_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertYahooJapanNewsItems(items, {
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
        console.warn(`[Sentiment/YahooJapanNews] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  deepPagesPerKeyword,
  normalizeBudget,
  normalizeYahooJapanUrl,
  yahooJapanNewsDedupeKey,
  parseYahooJapanDate,
  normalizeYahooJapanNewsKeywordText,
  yahooJapanNewsValueMatchesKeyword,
  countYahooJapanNewsRawResults,
  parseYahooJapanNewsResults,
  yahooJapanNewsKeywordMatchSource,
  yahooJapanNewsKeywordDiagnostics,
  yahooJapanNewsMediaNarrativeSignals,
};
