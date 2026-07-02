/**
 * scrapers/apple-podcast-search.js — Apple Podcasts public search
 *
 * Uses Apple's public iTunes Search API as a free podcast/audio discovery
 * surface. No paid API key is required.
 */

import { isAfterSince, isRecentDate } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const APPLE_ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const APPLE_ITUNES_LOOKUP_URL = "https://itunes.apple.com/lookup";
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const PODCAST_CONTEXT_TERMS = [
  "podcast",
  "episode",
  "audio",
  "interview",
  "show",
  "节目",
  "節目",
  "播客",
  "音频",
  "音頻",
  "访谈",
  "訪談",
  "complaint",
  "crisis",
  "refund",
  "scam",
  "privacy",
  "boycott",
];

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
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

function normalizeDiscoveredPodcastShows(shows = []) {
  return (Array.isArray(shows) ? shows : [])
    .map(show => ({
      collectionId: cleanText(show?.collectionId || show?.collection_id || show?.id || "", 80),
      showName: cleanText(show?.showName || show?.show_name || show?.name || show?.title || "", 180),
      country: cleanText(show?.country || "", 12).toLowerCase(),
      url: normalizeUrl(show?.url || ""),
      keywords: Array.isArray(show?.keywords_checked)
        ? show.keywords_checked
        : Array.isArray(show?.keywords)
          ? show.keywords
          : [],
    }))
    .filter(show => /^\d{5,}$/.test(show.collectionId))
    .filter((show, index, arr) => arr.findIndex(item => item.collectionId === show.collectionId) === index)
    .slice(0, 30);
}

function normalizePublishedAt(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function normalizeUrl(rawUrl = "") {
  try {
    const url = new URL(String(rawUrl || "").trim());
    url.hash = "";
    for (const key of ["at", "ct", "uo", "app", "mt", "ls", "ign-mpt"]) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return cleanText(rawUrl, 800);
  }
}

function normalizeApplePodcastDedupeUrl(value = "") {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["at", "ct", "uo", "app", "mt", "ls", "ign-mpt", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function applePodcastSearchDedupeKey(item = {}) {
  return normalizeApplePodcastDedupeUrl(item?.url || "");
}

function normalizeApplePodcastKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function applePodcastKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeApplePodcastKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function applePodcastValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeApplePodcastKeywordText(value);
  return applePodcastKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeApplePodcastKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function applePodcastKeywordMatchSource(item = {}, keyword = "") {
  if (!applePodcastKeywordNeedles(keyword).length) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["podcast_collection", item.metrics?.podcast_collection],
    ["podcast_artist", item.metrics?.podcast_artist],
    ["podcast_genre", item.metrics?.podcast_genre],
    ["source_kind", item.metrics?.source_kind],
    ["audio_url", item.metrics?.audio_url],
  ];
  for (const [field, value] of fields) {
    if (applePodcastValueMatchesKeyword(value, keyword)) return field;
  }
  return "search_query";
}

function applePodcastKeywordDiagnostics(item = {}, keyword = "") {
  return {
    apple_podcast_matched_keyword: cleanText(keyword, 160),
    apple_podcast_keyword_match_source: applePodcastKeywordMatchSource(item, keyword),
  };
}

function applePodcastTermMatches(text = "", terms = []) {
  const source = normalizeApplePodcastKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeApplePodcastKeywordText(term);
    return needle && source.includes(needle);
  });
}

function applePodcastAudioRiskSignals(item = {}) {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""} ${metrics.podcast_collection || ""} ${metrics.podcast_artist || ""}`;
  const hasTrackId = Boolean(metrics.podcast_track_id || item.trackId);
  const hasCollectionId = Boolean(metrics.podcast_collection_id || item.collectionId);
  const hasAudioUrl = Boolean(metrics.audio_url || item.episodeUrl || item.previewUrl || item.feedUrl);
  const hasCountry = Boolean(metrics.podcast_country || item.country);
  const explicitness = cleanText(metrics.podcast_explicitness || item.trackExplicitness || item.collectionExplicitness || "", 80).toLowerCase();
  const isExplicit = /explicit|notclean|yes|true|限制|成人/i.test(explicitness);
  const evidenceTerms = applePodcastTermMatches(text, [
    "screenshot", "screen recording", "proof", "receipt", "documents", "invoice", "chat log", "timeline", "investigation",
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "憑證", "凭证", "文件", "發票", "发票", "聊天紀錄", "聊天记录",
    "時間線", "时间线", "調查", "调查", "爆料", "實測", "实测",
  ]);
  const responseTerms = applePodcastTermMatches(text, [
    "official response", "official statement", "public response", "apology", "clarification", "customer support response",
    "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回應", "客服回应",
    "道歉", "致歉", "澄清", "說明", "说明",
  ]);
  const deepDiveTerms = applePodcastTermMatches(text, [
    "deep dive", "interview", "investigation", "timeline", "case study", "analysis", "explained", "special episode",
    "深度", "專訪", "专访", "訪談", "访谈", "調查", "调查", "時間線", "时间线", "解析", "分析", "懶人包", "懒人包",
  ]);
  const propagationTerms = applePodcastTermMatches(text, [
    "viral", "spread", "spreading", "backlash", "boycott", "follow-up", "follow up", "reposted", "shared", "amplified",
    "延燒", "延烧", "擴散", "扩散", "發酵", "发酵", "熱議", "热议", "轉傳", "转传", "抵制", "後續", "后续", "跟進", "跟进",
  ]);
  const crisisTerms = applePodcastTermMatches(text, [
    "complaint", "refund", "scam", "fraud", "privacy", "data leak", "security", "boycott", "crisis", "lawsuit",
    "投訴", "投诉", "退款", "詐騙", "诈骗", "隱私", "隐私", "個資", "个人信息", "資料外洩", "数据泄露",
    "安全", "抵制", "危機", "危机", "提告", "訴訟", "诉讼",
  ]);
  const reasons = [];
  if (hasTrackId) reasons.push("podcast-track-id-present");
  if (hasCollectionId) reasons.push("podcast-collection-id-present");
  if (hasAudioUrl) reasons.push("podcast-audio-url-present");
  if (hasCountry) reasons.push("podcast-country-present");
  if (isExplicit) reasons.push("podcast-explicit-content");
  if (evidenceTerms.length) reasons.push("podcast-evidence-language");
  if (responseTerms.length) reasons.push("podcast-response-language");
  if (deepDiveTerms.length) reasons.push("podcast-deep-dive-language");
  if (propagationTerms.length) reasons.push("podcast-propagation-language");
  if (crisisTerms.length) reasons.push("podcast-crisis-language");
  const audioTraceability = hasTrackId || hasCollectionId || hasAudioUrl;
  const semanticSignalCount = [
    crisisTerms.length,
    evidenceTerms.length,
    responseTerms.length,
    deepDiveTerms.length || propagationTerms.length,
    audioTraceability,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5
    && crisisTerms.length > 0
    && evidenceTerms.length > 0
    && responseTerms.length > 0
    && (deepDiveTerms.length > 0 || propagationTerms.length > 0)
    && audioTraceability;
  if (completeNarrative) reasons.push("podcast-complete-audio-crisis-narrative");
  const score = Math.min(100,
    (hasTrackId ? 6 : 0)
    + (hasCollectionId ? 4 : 0)
    + (hasAudioUrl ? 6 : 0)
    + (hasCountry ? 4 : 0)
    + (isExplicit ? 6 : 0)
    + (evidenceTerms.length ? 16 : 0)
    + (responseTerms.length ? 10 : 0)
    + (deepDiveTerms.length ? 12 : 0)
    + (propagationTerms.length ? 8 : 0)
    + (crisisTerms.length ? 20 : 0));
  return {
    apple_podcast_audio_risk_score: score,
    apple_podcast_audio_risk_bucket: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    apple_podcast_audio_risk_reasons: [...new Set(reasons)],
    apple_podcast_track_id_signal: hasTrackId ? 1 : 0,
    apple_podcast_collection_id_signal: hasCollectionId ? 1 : 0,
    apple_podcast_audio_url_signal: hasAudioUrl ? 1 : 0,
    apple_podcast_country_signal: hasCountry ? 1 : 0,
    apple_podcast_explicit_signal: isExplicit ? 1 : 0,
    apple_podcast_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    apple_podcast_response_language_signal: responseTerms.length ? 1 : 0,
    apple_podcast_deep_dive_language_signal: deepDiveTerms.length ? 1 : 0,
    apple_podcast_propagation_language_signal: propagationTerms.length ? 1 : 0,
    apple_podcast_crisis_language_signal: crisisTerms.length ? 1 : 0,
    apple_podcast_evidence_terms: evidenceTerms,
    apple_podcast_response_terms: responseTerms,
    apple_podcast_deep_dive_terms: deepDiveTerms,
    apple_podcast_propagation_terms: propagationTerms,
    apple_podcast_audio_semantic_signal_count: semanticSignalCount,
    apple_podcast_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
  };
}

function itemAudioUrl(item = {}) {
  const candidates = [
    item.episodeUrl,
    item.previewUrl,
    item.feedUrl,
    item.artworkUrl600,
    item.artworkUrl100,
  ];
  return candidates.find(value => /^https?:\/\//i.test(String(value || ""))) || "";
}

function itemLandingUrl(item = {}) {
  return normalizeUrl(item.trackViewUrl || item.collectionViewUrl || item.artistViewUrl || item.feedUrl || "");
}

function itemTitle(item = {}) {
  return cleanText(item.trackName || item.collectionName || item.artistName || "", 280);
}

function itemContent(item = {}) {
  return cleanText([
    item.shortDescription,
    item.description,
    item.collectionName,
    item.artistName,
    item.primaryGenreName,
    Array.isArray(item.genres) ? item.genres.join(" ") : "",
  ].filter(Boolean).join(" "), 1600);
}

function textMatchesKeyword({ title = "", content = "" } = {}, keyword = "") {
  if (!applePodcastKeywordNeedles(keyword).length) return true;
  return applePodcastValueMatchesKeyword(`${title} ${content}`, keyword);
}

function textHasPodcastContext({ title = "", content = "" } = {}) {
  const text = `${title} ${content}`.toLowerCase();
  return PODCAST_CONTEXT_TERMS.some(term => text.includes(term.toLowerCase()));
}

export function parseApplePodcastResults(payload, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  const now = new Date();
  for (const item of results) {
    const wrapperType = cleanText(item.wrapperType || "", 80).toLowerCase();
    const kind = cleanText(item.kind || "", 80).toLowerCase();
    if (wrapperType && !["track", "audiobook", "podcast"].includes(wrapperType)) continue;
    if (kind && !/podcast|podcast-episode|audio|audiobook/i.test(kind)) continue;
    const title = itemTitle(item);
    const content = itemContent(item);
    const url = itemLandingUrl(item);
    if (!title || !url) continue;
    if (!textMatchesKeyword({ title, content }, keyword)) continue;
    if (!textHasPodcastContext({ title, content })) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const publishedAt = normalizePublishedAt(item.releaseDate || item.collectionExplicitness || "");
    if (!isRecentDate(new Date(publishedAt), now)) continue;
    if (!isAfterSince(publishedAt, since)) continue;
    out.push({
      url,
      title,
      content,
      author: cleanText(item.artistName || item.collectionName || "Apple Podcasts", 160),
      publishedAt,
      metrics: {
        source: "apple_podcast_search",
        source_family: "audio",
        source_kind: "apple_podcasts_public_search",
        collection_mode: "itunes_search_public_json",
        podcast_collection: cleanText(item.collectionName || "", 240),
        podcast_artist: cleanText(item.artistName || "", 160),
        podcast_genre: cleanText(item.primaryGenreName || "", 120),
        podcast_track_id: cleanText(item.trackId || "", 80),
        podcast_collection_id: cleanText(item.collectionId || "", 80),
        podcast_country: cleanText(item.country || "", 20),
        podcast_explicitness: cleanText(item.trackExplicitness || item.collectionExplicitness || "", 60),
        audio_url: itemAudioUrl(item),
        artwork_url: /^https?:\/\//i.test(String(item.artworkUrl600 || item.artworkUrl100 || "")) ? (item.artworkUrl600 || item.artworkUrl100) : "",
      },
    });
    Object.assign(out[out.length - 1].metrics, applePodcastAudioRiskSignals(out[out.length - 1]));
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

function buildApplePodcastSearchUrl(keyword = "", { offset = 0, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, country = "us", language = "en_us" } = {}) {
  const params = new URLSearchParams({
    term: keyword,
    media: "podcast",
    entity: "podcastEpisode",
    attribute: "titleTerm",
    limit: String(Math.max(1, Math.min(200, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    offset: String(Math.max(0, Number(offset) || 0)),
    country: cleanText(country || "us", 12).toLowerCase(),
    lang: cleanText(language || "en_us", 12).toLowerCase(),
  });
  return `${APPLE_ITUNES_SEARCH_URL}?${params.toString()}`;
}

function buildApplePodcastLookupUrl(collectionId = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, country = "us", language = "en_us" } = {}) {
  const params = new URLSearchParams({
    id: cleanText(collectionId, 80),
    media: "podcast",
    entity: "podcastEpisode",
    limit: String(Math.max(1, Math.min(200, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))),
    country: cleanText(country || "us", 12).toLowerCase(),
    lang: cleanText(language || "en_us", 12).toLowerCase(),
  });
  return `${APPLE_ITUNES_LOOKUP_URL}?${params.toString()}`;
}

async function insertApplePodcastItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null } = {}) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = applePodcastSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls?.has(dedupeKey)) continue;
    seenItemUrls?.add(dedupeKey);
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const result = insertSentimentItem({
      platform: "apple_podcast_search",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content: item.content, sentiment }),
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      evidence: {
        evidence_type: "apple_podcast_search_result",
        metrics: {
          ...(item.metrics || {}),
          ...applePodcastAudioRiskSignals(item),
          ...applePodcastKeywordDiagnostics(item, keyword),
          apple_podcast_canonical_dedupe_url: dedupeKey,
          apple_podcast_search_scan_dedupe_key: dedupeKey,
        },
      },
      source_type: "scraper",
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeApplePodcastSearch(keywords, { proxyUrl = "", budget = {}, since = "", country = "us", language = "en_us", discoveredPodcastShows = [], discovered_podcast_shows = [], domainControls = {}, contentControls = {} } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedShows = normalizeDiscoveredPodcastShows([...discoveredPodcastShows, ...discovered_podcast_shows]);
  if (!normalizedKeywords.length && !normalizedShows.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords) {
    let keywordInserted = 0;
    for (let page = 0; page < maxPagesPerKeyword; page += 1) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      const url = buildApplePodcastSearchUrl(`${keyword} ${PODCAST_CONTEXT_TERMS.slice(0, 4).join(" ")}`, {
        offset: page * maxItemsPerKeyword,
        limit: remaining,
        country,
        language,
      });
      try {
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, message: httpFailure(res) });
          continue;
        }
        const payload = await res.json();
        const rawResultCount = Array.isArray(payload?.results) ? payload.results.length : Number(payload?.resultCount || 0);
        const items = parseApplePodcastResults(payload, keyword, { limit: remaining, since }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            apple_podcast_search_page: page + 1,
            apple_podcast_search_offset: page * maxItemsPerKeyword,
            apple_podcast_search_raw_result_count: rawResultCount,
          },
        }));
        const count = await insertApplePodcastItems(items, { keyword, domainControls, contentControls, seenItemUrls });
        inserted += count;
        keywordInserted += count;
        if (!rawResultCount) break;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, message });
        console.warn(`[CRM/ApplePodcastSearch] 抓取失敗 keyword=${keyword}: ${message}`);
      }
    }
  }

  for (const show of normalizedShows) {
    const lookupCountry = show.country || country;
    const url = buildApplePodcastLookupUrl(show.collectionId, {
      limit: maxItemsPerKeyword,
      country: lookupCountry,
      language,
    });
    try {
      const res = await fetchPublicSource(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ target: `itunes-lookup:${show.collectionId}`, message: httpFailure(res) });
        continue;
      }
      const payload = await res.json();
      const rawResultCount = Array.isArray(payload?.results) ? payload.results.length : Number(payload?.resultCount || 0);
      const lookupKeywords = normalizedKeywords.length
        ? normalizedKeywords
        : normalizeDiscoveredPodcastShows([show])[0]?.showName
          ? [show.showName]
          : [];
      for (const keyword of lookupKeywords) {
        const items = parseApplePodcastResults(payload, keyword, { limit: maxItemsPerKeyword, since }).map(item => ({
          ...item,
          metrics: {
            ...(item.metrics || {}),
            collection_mode: "itunes_lookup_public_json",
            apple_podcast_lookup_collection_id: show.collectionId,
            apple_podcast_lookup_show_name: show.showName,
            apple_podcast_lookup_source_url: show.url,
            apple_podcast_lookup_raw_result_count: rawResultCount,
            apple_podcast_discovered_show_signal: 1,
          },
        }));
        inserted += await insertApplePodcastItems(items, {
          keyword,
          domainControls,
          contentControls,
          seenItemUrls,
        });
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ target: `itunes-lookup:${show.collectionId}`, message });
      console.warn(`[CRM/ApplePodcastSearch] 節目查詢失敗 collectionId=${show.collectionId}: ${message}`);
    }
  }

  return scraperResult(inserted, failures);
}

export const __test__ = {
  PODCAST_CONTEXT_TERMS,
  applePodcastSearchDedupeKey,
  buildApplePodcastSearchUrl,
  buildApplePodcastLookupUrl,
  normalizeApplePodcastDedupeUrl,
  normalizeApplePodcastKeywordText,
  normalizeDiscoveredPodcastShows,
  normalizeBudget,
  parseApplePodcastResults,
  applePodcastValueMatchesKeyword,
  applePodcastKeywordMatchSource,
  applePodcastKeywordDiagnostics,
  applePodcastAudioRiskSignals,
};
