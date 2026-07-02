/**
 * scrapers/daum-korea-news.js — Daum/Kakao 韓國公開新聞搜索
 *
 * Uses Daum public news search as a free regional discovery surface.
 */

import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const DAUM_KOREA_SEARCH_URL = "https://search.daum.net/search";
const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const KOREA_CONTEXT_TERMS = ["韓國", "韩国", "한국", "Korea", "뉴스", "news", "논란", "불만", "환불", "사기", "악평", "개인정보", "리콜", "집단소송", "정보 유출", "사과", "카카오", "다음"];

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

function normalizeDaumUrl(rawUrl = "") {
  const decoded = decodeHtml(rawUrl || "").trim();
  if (!decoded) return "";
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
    if (/(\.|^)daum\.net$/i.test(url.hostname) && /\/search|\/link/i.test(url.pathname)) {
      const direct = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("link");
      if (direct) return normalizeDaumUrl(decodeURIComponent(direct));
    }
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "q", "w", "sort", "DA", "nil_suggest"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function daumKoreaNewsDedupeKey(item = {}) {
  return normalizeDaumUrl(item.url || "");
}

function normalizeDaumKoreaNewsKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function daumKoreaNewsKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeDaumKoreaNewsKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function daumKoreaNewsValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeDaumKoreaNewsKeywordText(value);
  return daumKoreaNewsKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeDaumKoreaNewsKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function daumKoreaNewsKeywordMatchSource(item = {}, keyword = "") {
  if (!daumKoreaNewsKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
  ];
  const match = fields.find(([, value]) => daumKoreaNewsValueMatchesKeyword(value, keyword));
  return match?.[0] || "context";
}

function daumKoreaNewsKeywordDiagnostics(item = {}, keyword = "") {
  return {
    daum_korea_news_matched_keyword: stripTags(keyword, 160),
    daum_korea_news_keyword_match_source: daumKoreaNewsKeywordMatchSource(item, keyword),
  };
}

function daumKoreaNewsTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeDaumKoreaNewsKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeDaumKoreaNewsKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function daumKoreaNewsMediaNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = daumKoreaNewsTermMatches(text, [
    "스크린샷", "캡처", "녹음", "녹화", "증거", "자료", "영수증", "청구서", "주문번호", "타임라인",
    "조사", "폭로", "제보", "문서", "screenshot", "proof", "evidence", "receipt", "timeline", "investigation",
  ]);
  const impactTerms = daumKoreaNewsTermMatches(text, [
    "환불", "환불 거부", "고객 대응", "고객센터", "소비자", "이용자", "피해", "손실", "위험", "리스크",
    "사기", "불매", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = daumKoreaNewsTermMatches(text, [
    "공식 입장", "공식 발표", "공식 사과", "사과", "해명", "설명", "입장문", "대응", "고객 대응",
    "재발 방지", "개선책", "official response", "statement", "apology", "clarification",
  ]);
  const propagationTerms = daumKoreaNewsTermMatches(text, [
    "확산", "논란", "파장", "화제", "SNS", "온라인", "보도", "언론", "커뮤니티", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = daumKoreaNewsTermMatches(text, [
    "불만", "민원", "환불", "사기", "개인정보", "정보 유출", "유출", "리콜", "조사", "소송",
    "집단소송", "위기", "논란", "complaint", "refund", "scam", "breach", "recall", "lawsuit", "crisis",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("daum-korea-news-evidence-language");
  if (impactTerms.length) reasons.push("daum-korea-news-impact-language");
  if (responseTerms.length) reasons.push("daum-korea-news-official-response-language");
  if (propagationTerms.length) reasons.push("daum-korea-news-propagation-language");
  if (crisisTerms.length) reasons.push("daum-korea-news-crisis-language");
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
  if (completeNarrative) reasons.push("daum-korea-news-complete-media-crisis-narrative");
  return {
    daum_korea_news_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    daum_korea_news_media_impact_signal: impactTerms.length ? 1 : 0,
    daum_korea_news_media_official_response_signal: responseTerms.length ? 1 : 0,
    daum_korea_news_media_propagation_signal: propagationTerms.length ? 1 : 0,
    daum_korea_news_media_crisis_signal: crisisTerms.length ? 1 : 0,
    daum_korea_news_media_semantic_signal_count: semanticSignals,
    daum_korea_news_complete_media_crisis_narrative_signal: completeNarrative ? 1 : 0,
    daum_korea_news_media_evidence_terms: evidenceTerms,
    daum_korea_news_media_impact_terms: impactTerms,
    daum_korea_news_media_response_terms: responseTerms,
    daum_korea_news_media_propagation_terms: propagationTerms,
    daum_korea_news_media_crisis_terms: crisisTerms,
    daum_korea_news_media_narrative_reasons: reasons,
  };
}

function parseDaumKoreaDate(text = "", now = new Date()) {
  const source = String(text || "");
  const absoluteKo = /(\d{4})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})일?\.?/.exec(source);
  if (absoluteKo) return new Date(Number(absoluteKo[1]), Number(absoluteKo[2]) - 1, Number(absoluteKo[3]), 12, 0, 0);
  const monthDayKo = /(\d{1,2})[.\-월]\s*(\d{1,2})일?\.?/.exec(source);
  if (monthDayKo) {
    const candidate = new Date(now.getFullYear(), Number(monthDayKo[1]) - 1, Number(monthDayKo[2]), 12, 0, 0);
    if (candidate.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) candidate.setFullYear(now.getFullYear() - 1);
    return candidate;
  }
  const relativeKo = /(\d+)\s*(분|시간|일)\s*전/.exec(source);
  if (relativeKo) {
    const amount = Number(relativeKo[1]);
    if (!Number.isFinite(amount)) return null;
    if (relativeKo[2] === "분") return new Date(now.getTime() - amount * 60 * 1000);
    if (relativeKo[2] === "시간") return new Date(now.getTime() - amount * 60 * 60 * 1000);
    return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
  }
  if (/어제/.test(source)) return new Date(now.getTime() - 24 * 60 * 60 * 1000);
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

function shouldKeepDaumKoreaResult({ title = "", content = "", keyword = "" }) {
  const text = `${title} ${content}`.toLowerCase();
  if (keyword && !daumKoreaNewsValueMatchesKeyword(`${title} ${content}`, keyword)) return false;
  return KOREA_CONTEXT_TERMS.some(term => text.includes(term.toLowerCase())) || /[\uac00-\ud7af]/.test(text);
}

function parseAnchorAttributes(tag = "") {
  const attrs = {};
  const attrRegex = /([a-z0-9_:-]+)\s*=\s*(["'])(.*?)\2/gi;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) attrs[match[1].toLowerCase()] = decodeHtml(match[3]);
  return attrs;
}

function isLikelyDaumNewsAnchor(attrs = {}, href = "") {
  const className = String(attrs.class || "");
  if (/\b(f_link_b|tit_main|link_tit|tit_news|item-title)\b/i.test(className)) return true;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    return /(\.|^)(v\.daum\.net|news\.v\.daum\.net|daum\.net)$/i.test(url.hostname) && /\/v\/|\/news\/|\/article/i.test(url.pathname);
  } catch {
    return false;
  }
}

function countDaumKoreaNewsRawResults(html = "") {
  const source = String(html || "");
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let count = 0;
  let match;
  while ((match = anchorRegex.exec(source)) !== null) {
    const attrs = parseAnchorAttributes(match[1]);
    if (!attrs.href || !isLikelyDaumNewsAnchor(attrs, attrs.href)) continue;
    const url = normalizeDaumUrl(attrs.href);
    if (url && !/\/\/search\.daum\.net\//i.test(url)) count += 1;
  }
  return count;
}

export function parseDaumKoreaNewsResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const source = String(html || "");
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const now = new Date();
  const out = [];
  const seen = new Set();
  let match;
  while ((match = anchorRegex.exec(source)) !== null) {
    const attrs = parseAnchorAttributes(match[1]);
    if (!attrs.href || !isLikelyDaumNewsAnchor(attrs, attrs.href)) continue;
    const url = normalizeDaumUrl(attrs.href);
    const title = stripTags(match[2], 240);
    if (!url || !title || /\/\/search\.daum\.net\//i.test(url)) continue;
    const nextStart = anchorRegex.lastIndex;
    const nextAnchor = source.slice(nextStart).search(/<a\b/i);
    const block = source.slice(nextStart, nextAnchor >= 0 ? nextStart + nextAnchor : Math.min(source.length, nextStart + 1800));
    const content = stripTags(block, 1000);
    if (!shouldKeepDaumKoreaResult({ title, content, keyword })) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const date = parseDaumKoreaDate(`${title} ${content}`, now) || now;
    const publishedAt = date.toISOString();
    if (!isRecentDate(date, now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: "Daum/Kakao 韓國公開搜索",
      publishedAt,
      metrics: {
        public_search_engine: "daum_news_search",
        source_kind: "daum_korea_public_news_search",
        news_region: "korea",
        news_language: "ko-KR",
        collection_mode: "site_daum_korea_public_news_search",
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertDaumKoreaNewsItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = daumKoreaNewsDedupeKey(item);
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
      platform: "daum_korea_news",
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
        source_key: "daumKoreaNews",
        evidence_type: enriched.evidence?.evidence_type || "daum_korea_news_result",
        metrics: {
          ...evidenceMetrics,
          ...daumKoreaNewsKeywordDiagnostics({ ...item, content, author: itemAuthor, metrics: evidenceMetrics }, keyword),
          daum_korea_news_canonical_dedupe_url: dedupeKey,
          daum_korea_news_search_scan_dedupe_key: dedupeKey,
          ...daumKoreaNewsMediaNarrativeSignals({ ...item, content, author: itemAuthor }),
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

export async function scrapeDaumKoreaNews(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 1; page <= maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const query = `${keyword} (${KOREA_CONTEXT_TERMS.slice(2, 9).join(" OR ")})`;
      const url = `${DAUM_KOREA_SEARCH_URL}?w=news&q=${encodeURIComponent(query)}&sort=recency&p=${page}`;
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8,zh-TW;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const rawResultCount = countDaumKoreaNewsRawResults(html);
        const items = parseDaumKoreaNewsResults(html, keyword, {
          limit: remaining,
          since,
        }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            daum_korea_news_search_page: page,
            daum_korea_news_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertDaumKoreaNewsItems(items, {
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
        console.warn(`[Sentiment/DaumKoreaNews] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  deepPagesPerKeyword,
  normalizeBudget,
  normalizeDaumUrl,
  daumKoreaNewsDedupeKey,
  parseDaumKoreaDate,
  normalizeDaumKoreaNewsKeywordText,
  daumKoreaNewsValueMatchesKeyword,
  countDaumKoreaNewsRawResults,
  parseDaumKoreaNewsResults,
  daumKoreaNewsKeywordMatchSource,
  daumKoreaNewsKeywordDiagnostics,
  daumKoreaNewsMediaNarrativeSignals,
};
