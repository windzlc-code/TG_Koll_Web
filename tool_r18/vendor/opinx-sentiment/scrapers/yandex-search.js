/**
 * scrapers/yandex-search.js — Yandex 公開搜索
 *
 * Uses Yandex public web search as a free discovery surface for Russian/CIS
 * and broader open-web public-opinion signals.
 */

import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const YANDEX_SEARCH_URL = "https://yandex.com/search/";
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const YANDEX_CONTEXT_TERMS = ["новости", "отзыв", "жалоба", "скандал", "мошенничество", "возврат", "утечка", "бойкот", "расследование", "news", "review", "complaint", "scam", "refund", "privacy"];

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

function normalizeYandexUrl(rawUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded) return "";
  try {
    const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded.startsWith("/") ? `https://yandex.com${decoded}` : decoded;
    const url = new URL(absolute);
    const direct = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target") || url.searchParams.get("to");
    if (direct && /^https?:\/\//i.test(direct)) return normalizeYandexUrl(decodeURIComponent(direct));
    if (/(\.|^)yandex\.(com|ru|kz|by|uz|com\.tr)$/i.test(url.hostname) && /\/(?:search|clck|images|video|maps|support)/i.test(url.pathname)) return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "yclid", "from", "text", "lr", "clid"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeYandexDedupeUrl(rawUrl = "") {
  const normalized = normalizeYandexUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "yclid",
      "from",
      "text",
      "lr",
      "clid",
      "src",
      "source",
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

function yandexSearchDedupeKey(item = {}) {
  return normalizeYandexDedupeUrl(item?.url || "");
}

function normalizeYandexKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u0400-\u04ff\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function yandexKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeYandexKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function yandexValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeYandexKeywordText(value);
  return yandexKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeYandexKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function yandexKeywordMatchSource(item = {}, keyword = "") {
  if (!yandexKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
  ];
  const match = fields.find(([, value]) => yandexValueMatchesKeyword(value, keyword));
  return match?.[0] || "context";
}

function yandexKeywordDiagnostics(item = {}, keyword = "") {
  return {
    yandex_matched_keyword: stripTags(keyword, 160),
    yandex_keyword_match_source: yandexKeywordMatchSource(item, keyword),
  };
}

function yandexTermMatches(text = "", terms = []) {
  const source = normalizeYandexKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeYandexKeywordText(term);
    return needle && source.includes(needle);
  });
}

function yandexPublicSearchNarrativeSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = [
    item.title,
    item.content,
    item.author,
    metrics.article_body_excerpt,
    metrics.description,
    metrics.keywords,
    metrics.og_title,
    metrics.og_description,
  ].filter(Boolean).join(" ");
  const evidenceTerms = yandexTermMatches(text, [
    "proof", "evidence", "screenshot", "receipt", "invoice", "document", "timeline", "recording", "chat log",
    "доказательство", "доказательства", "скриншот", "чек", "квитанция", "документ", "документы", "таймлайн", "хронология", "запись", "переписка",
    "截圖", "截图", "證據", "证据", "收據", "收据", "發票", "发票", "文件", "時間線", "时间线", "錄音", "录音",
  ]);
  const impactTerms = yandexTermMatches(text, [
    "customer", "user", "consumer", "refund", "delay", "loss", "privacy", "data leak", "service outage", "security",
    "клиент", "пользователь", "потребитель", "возврат", "задержка", "ущерб", "потери", "конфиденциальность", "утечка", "сбой", "безопасность",
    "客戶", "客户", "用戶", "用户", "消費者", "消费者", "退款", "延遲", "延迟", "損失", "损失", "隱私", "隐私", "泄露", "故障", "安全",
  ]);
  const responseTerms = yandexTermMatches(text, [
    "official response", "official statement", "statement", "response", "apology", "clarification", "support", "customer service", "regulator",
    "официальный ответ", "официальное заявление", "заявление", "ответ", "извинение", "разъяснение", "поддержка", "служба поддержки", "регулятор",
    "官方回應", "官方回应", "官方聲明", "官方声明", "聲明", "声明", "回應", "回应", "道歉", "澄清", "客服", "監管", "监管",
  ]);
  const propagationTerms = yandexTermMatches(text, [
    "viral", "spread", "spreading", "discussed", "discussion", "backlash", "boycott", "media coverage", "social media", "cross-platform",
    "вирусный", "распространение", "распространяется", "обсуждается", "обсуждение", "резонанс", "бойкот", "СМИ", "соцсети",
    "擴散", "扩散", "熱議", "热议", "討論", "讨论", "抵制", "媒體報導", "媒体报道", "社群", "社交媒體", "社交媒体", "跨平台",
  ]);
  const crisisTerms = yandexTermMatches(text, [
    "complaint", "dispute", "scam", "fraud", "lawsuit", "investigation", "recall", "boycott", "crisis", "breach",
    "жалоба", "спор", "мошенничество", "иск", "суд", "расследование", "отзыв", "бойкот", "кризис", "скандал", "утечка",
    "投訴", "投诉", "爭議", "争议", "詐騙", "诈骗", "訴訟", "诉讼", "調查", "调查", "召回", "抵制", "危機", "危机", "醜聞", "丑闻",
  ]);
  const semanticSignals = [
    evidenceTerms.length,
    impactTerms.length,
    responseTerms.length,
    propagationTerms.length,
    crisisTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  const reasons = [];
  if (evidenceTerms.length) reasons.push("yandex-evidence-language");
  if (impactTerms.length) reasons.push("yandex-impact-language");
  if (responseTerms.length) reasons.push("yandex-official-response-language");
  if (propagationTerms.length) reasons.push("yandex-propagation-language");
  if (crisisTerms.length) reasons.push("yandex-crisis-language");
  if (completeNarrative) reasons.push("yandex-complete-public-search-crisis-narrative");
  return {
    yandex_public_search_evidence_signal: evidenceTerms.length ? 1 : 0,
    yandex_public_search_impact_signal: impactTerms.length ? 1 : 0,
    yandex_public_search_official_response_signal: responseTerms.length ? 1 : 0,
    yandex_public_search_propagation_signal: propagationTerms.length ? 1 : 0,
    yandex_public_search_crisis_signal: crisisTerms.length ? 1 : 0,
    yandex_public_search_semantic_signal_count: semanticSignals,
    yandex_public_search_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    yandex_public_search_evidence_terms: [...new Set(evidenceTerms)].slice(0, 12),
    yandex_public_search_impact_terms: [...new Set(impactTerms)].slice(0, 12),
    yandex_public_search_response_terms: [...new Set(responseTerms)].slice(0, 12),
    yandex_public_search_propagation_terms: [...new Set(propagationTerms)].slice(0, 12),
    yandex_public_search_crisis_terms: [...new Set(crisisTerms)].slice(0, 12),
    yandex_public_search_narrative_reasons: reasons,
  };
}

function parseYandexDate(text = "", now = new Date()) {
  const source = String(text || "");
  const months = new Map([
    ["янв", 0], ["январ", 0], ["фев", 1], ["феврал", 1], ["мар", 2], ["март", 2],
    ["апр", 3], ["апрел", 3], ["мая", 4], ["май", 4], ["июн", 5], ["июн", 5],
    ["июл", 6], ["июл", 6], ["авг", 7], ["август", 7], ["сен", 8], ["сентябр", 8],
    ["окт", 9], ["октябр", 9], ["ноя", 10], ["ноябр", 10], ["дек", 11], ["декабр", 11],
  ]);
  const absoluteRu = /(\d{1,2})\s+([А-Яа-яёЁ.]+)\s+(\d{4})/.exec(source);
  if (absoluteRu) {
    const token = absoluteRu[2].replace(/\./g, "").toLowerCase();
    const key = [...months.keys()].find(item => token.startsWith(item));
    if (key) return new Date(Number(absoluteRu[3]), months.get(key), Number(absoluteRu[1]), 12, 0, 0);
  }
  const absoluteNumeric = /(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(source);
  if (absoluteNumeric) return new Date(Number(absoluteNumeric[1]), Number(absoluteNumeric[2]) - 1, Number(absoluteNumeric[3]), 12, 0, 0);
  const relativeRu = /(\d+)\s*(минут[а-я]*|час[а-я]*|дн[яей]*)\s+назад/i.exec(source);
  if (relativeRu) {
    const amount = Number(relativeRu[1]);
    if (!Number.isFinite(amount)) return null;
    if (/минут/i.test(relativeRu[2])) return new Date(now.getTime() - amount * 60 * 1000);
    if (/час/i.test(relativeRu[2])) return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  if (/вчера/i.test(source)) return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const absoluteEn = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(source);
  if (absoluteEn) return new Date(`${absoluteEn[1]} ${absoluteEn[2]}, ${absoluteEn[3]} 12:00:00`);
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

function candidateBlocks(html = "") {
  const source = String(html || "");
  const blocks = [];
  const blockRegex = /<(?:li|div)[^>]+class=["'][^"']*(?:serp-item|organic|VanillaReact)[^"']*["'][^>]*>[\s\S]*?(?=<(?:li|div)[^>]+class=["'][^"']*(?:serp-item|organic|VanillaReact)[^"']*["']|<\/body>|$)/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    if (/<a[^>]+href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/i.test(match[0])) blocks.push(match[0]);
  }
  if (blocks.length) return blocks;
  return [...source.matchAll(/<h2[^>]*>[\s\S]*?<a[^>]+href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>[\s\S]*?(?=<h2|$)/gi)].map(item => item[0]);
}

function countYandexRawResults(html = "") {
  return candidateBlocks(html).filter(block => {
    const link = block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/i);
    return Boolean(link && normalizeYandexUrl(link[1]));
  }).length;
}

function shouldKeepYandexResult({ title = "", content = "", keyword = "" }) {
  const text = `${title} ${content}`.toLowerCase();
  if (!yandexValueMatchesKeyword(`${title} ${content}`, keyword)) return false;
  return YANDEX_CONTEXT_TERMS.some(term => text.includes(term.toLowerCase())) || /[\u0400-\u04ff]/.test(text);
}

export function parseYandexSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const now = new Date();
  const out = [];
  const seen = new Set();
  for (const block of candidateBlocks(html)) {
    const link = block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = normalizeYandexUrl(link[1]);
    const title = stripTags(link[2], 240);
    const blockText = stripTags(block, 1400);
    const content = blockText.replace(title, "").trim().slice(0, 900);
    if (!url || !title) continue;
    if (!shouldKeepYandexResult({ title, content, keyword })) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseYandexDate(blockText, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: "Yandex 公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "yandex_web",
        source_kind: "yandex_public_search",
        source_region: "russian_cis_open_web",
        collection_mode: "public_html_search",
        ...yandexPublicSearchNarrativeSignals({ title, content, author: "Yandex 公開搜索" }),
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertYandexItems(items, {
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
    const dedupeKey = yandexSearchDedupeKey(item);
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
    const narrativeMetrics = yandexPublicSearchNarrativeSignals({
      ...item,
      content,
      author: itemAuthor,
      metrics: evidenceMetrics,
    });
    const result = insertSentimentItem({
      platform: "yandex_search",
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
        source_key: "yandexSearch",
        evidence_type: enriched.evidence?.evidence_type || "yandex_public_search_result",
        metrics: {
          ...evidenceMetrics,
          ...narrativeMetrics,
          ...yandexKeywordDiagnostics({ ...item, content, author: itemAuthor, metrics: evidenceMetrics }, keyword),
          yandex_canonical_dedupe_url: dedupeKey,
          yandex_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeYandexSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  const seenItemUrls = new Set();
  let inserted = 0;
  const failures = [];

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `${keyword} (${YANDEX_CONTEXT_TERMS.slice(0, 8).join(" OR ")})`;
      const url = `${YANDEX_SEARCH_URL}?text=${encodeURIComponent(query)}&p=${page}&lr=10393`;
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8,zh-TW;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const rawResultCount = countYandexRawResults(html);
        const items = parseYandexSearchResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            yandex_search_page: page + 1,
            yandex_search_offset: page,
            yandex_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertYandexItems(items, {
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
        console.warn(`[Sentiment/YandexSearch] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  deepPagesPerKeyword,
  normalizeBudget,
  normalizeYandexUrl,
  normalizeYandexDedupeUrl,
  yandexSearchDedupeKey,
  normalizeYandexKeywordText,
  yandexKeywordNeedles,
  yandexValueMatchesKeyword,
  yandexPublicSearchNarrativeSignals,
  parseYandexDate,
  countYandexRawResults,
  parseYandexSearchResults,
  yandexKeywordMatchSource,
  yandexKeywordDiagnostics,
};
