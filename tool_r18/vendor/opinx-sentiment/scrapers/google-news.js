/**
 * scrapers/google-news.js — Google News RSS 爬蟲（免費，無需 API key）
 * 使用 Google/Bing News RSS feed，覆盖台湾与主要海外新闻市场。
 */

import { isAfterSince, isRecentDate, isTaiwanRecentItem } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const REQUEST_TIMEOUT_MS = 15000;
const KEYWORD_CONCURRENCY = 4;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const NEWS_RSS_ENGINES = ["google_news", "bing_news_rss"];
const DEFAULT_GOOGLE_NEWS_ENGINES = ["google_news"];
const DEFAULT_BING_NEWS_ENGINES = ["bing_news_rss"];
const NEWS_RISK_QUERY_TEMPLATES = [
  { key: "complaint_refund", terms: ["complaint", "refund", "dispute", "投訴", "投诉", "客訴", "退款"] },
  { key: "fraud_scam", terms: ["scam", "fraud", "phishing", "詐騙", "诈骗", "欺詐", "欺诈"] },
  { key: "safety_recall", terms: ["recall", "safety alert", "warning", "召回", "安全警示", "風險", "风险"] },
  { key: "crisis_response", terms: ["statement", "response", "apology", "boycott", "聲明", "声明", "回應", "回应", "抵制"] },
];
const NEWS_MARKET_PROFILES = [
  { key: "TW", region: "taiwan", googleHl: "zh-TW", googleGl: "TW", googleCeid: "TW:zh-Hant", bingMkt: "zh-TW", bingCc: "tw", queryTerms: ["台灣", "Taiwan"] },
  { key: "US", region: "united_states", googleHl: "en-US", googleGl: "US", googleCeid: "US:en", bingMkt: "en-US", bingCc: "us", queryTerms: [] },
  { key: "HK", region: "hong_kong", googleHl: "zh-HK", googleGl: "HK", googleCeid: "HK:zh-Hant", bingMkt: "zh-HK", bingCc: "hk", queryTerms: [] },
  { key: "SG", region: "singapore", googleHl: "en-SG", googleGl: "SG", googleCeid: "SG:en", bingMkt: "en-SG", bingCc: "sg", queryTerms: [] },
  { key: "JP", region: "japan", googleHl: "ja-JP", googleGl: "JP", googleCeid: "JP:ja", bingMkt: "ja-JP", bingCc: "jp", queryTerms: [] },
  { key: "KR", region: "korea", googleHl: "ko-KR", googleGl: "KR", googleCeid: "KR:ko", bingMkt: "ko-KR", bingCc: "kr", queryTerms: [] },
  { key: "GB", region: "united_kingdom", googleHl: "en-GB", googleGl: "GB", googleCeid: "GB:en", bingMkt: "en-GB", bingCc: "gb", queryTerms: [] },
  { key: "CA", region: "canada", googleHl: "en-CA", googleGl: "CA", googleCeid: "CA:en", bingMkt: "en-CA", bingCc: "ca", queryTerms: [] },
  { key: "AU", region: "australia", googleHl: "en-AU", googleGl: "AU", googleCeid: "AU:en", bingMkt: "en-AU", bingCc: "au", queryTerms: [] },
  { key: "DE", region: "germany", googleHl: "de-DE", googleGl: "DE", googleCeid: "DE:de", bingMkt: "de-DE", bingCc: "de", queryTerms: [] },
  { key: "FR", region: "france", googleHl: "fr-FR", googleGl: "FR", googleCeid: "FR:fr", bingMkt: "fr-FR", bingCc: "fr", queryTerms: [] },
  { key: "IN", region: "india", googleHl: "en-IN", googleGl: "IN", googleCeid: "IN:en", bingMkt: "en-IN", bingCc: "in", queryTerms: [] },
  { key: "BR", region: "brazil", googleHl: "pt-BR", googleGl: "BR", googleCeid: "BR:pt-419", bingMkt: "pt-BR", bingCc: "br", queryTerms: [] },
  { key: "MX", region: "mexico", googleHl: "es-MX", googleGl: "MX", googleCeid: "MX:es-419", bingMkt: "es-MX", bingCc: "mx", queryTerms: [] },
  { key: "AE", region: "middle_east", googleHl: "en-AE", googleGl: "AE", googleCeid: "AE:en", bingMkt: "en-AE", bingCc: "ae", queryTerms: [] },
];

function budgetItems(budget = {}, fallback = DEFAULT_MAX_ITEMS_PER_KEYWORD) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || fallback));
  return Number.isFinite(value) ? Math.min(50, Math.max(1, value)) : fallback;
}

function normalizeNewsDeepBudget(deepBudget = null) {
  const raw = deepBudget && typeof deepBudget === "object" ? deepBudget : {};
  const enabled = raw.riskQueryExpansion ?? raw.risk_query_expansion ?? raw.enableRiskQueries ?? raw.enable_risk_queries ?? true;
  const maxRiskQueries = Math.round(Number(raw.maxRiskQueriesPerKeyword ?? raw.max_risk_queries_per_keyword ?? raw.maxRiskQueries ?? raw.max_risk_queries ?? 1));
  return {
    riskQueryExpansion: enabled !== false,
    maxRiskQueriesPerKeyword: Number.isFinite(maxRiskQueries) ? Math.max(0, Math.min(NEWS_RISK_QUERY_TEMPLATES.length, maxRiskQueries)) : 1,
  };
}

function evidenceWithFailover(evidence = {}, failoverAttribution = [], itemMetrics = {}) {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  if (!attribution.length && !Object.keys(itemMetrics || {}).length) return evidence || {};
  return {
    ...(evidence || {}),
    metrics: {
      ...(evidence?.metrics || {}),
      ...(itemMetrics || {}),
      failover_attribution: attribution,
      failover_from_sources: [...new Set(attribution.map(item => item?.fromSource).filter(Boolean))],
    },
  };
}

function decodeXml(text = "") {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(text = "") {
  return decodeXml(text).replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagRaw(block = "", tag = "") {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1] : "";
}

function tagValue(block = "", tag = "") {
  return stripTags(tagRaw(block, tag));
}

function normalizeArticleUrl(rawUrl = "") {
  const decoded = decodeXml(rawUrl).trim();
  if (!decoded) return "";
  try {
    const url = new URL(decoded);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeNewsDedupeUrl(rawUrl = "") {
  const normalized = normalizeArticleUrl(rawUrl);
  if (!normalized) return "";
  try {
    let url = new URL(normalized);
    if (isAggregatorNewsUrl(url.toString())) {
      const unwrapped = ["url", "u", "r", "target"]
        .map(key => url.searchParams.get(key))
        .find(Boolean);
      if (unwrapped) url = new URL(normalizeArticleUrl(unwrapped));
    }
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ocid",
      "cid",
      "ref",
      "ref_src",
      "source",
      "output",
      "mc_cid",
      "mc_eid",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/amp\/?$/i, "").replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function isAggregatorNewsUrl(url = "") {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)news\.google\.com$|(^|\.)bing\.com$|(^|\.)msn\.com$/.test(host);
  } catch {
    return false;
  }
}

function extractDescriptionArticleUrl(descriptionHtml = "", fallbackUrl = "") {
  const source = decodeXml(descriptionHtml);
  const fallback = normalizeArticleUrl(fallbackUrl);
  const links = [...source.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
    .map(match => normalizeArticleUrl(match[1]))
    .filter(Boolean);
  return links.find(url => !isAggregatorNewsUrl(url)) || fallback;
}

function extractSourceUrl(block = "") {
  const sourceTag = String(block || "").match(/<source\b[^>]*url=["']([^"']+)["'][^>]*>/i);
  return normalizeArticleUrl(sourceTag?.[1] || "");
}

function newsItemDedupeKey(item = {}) {
  const candidates = [
    item.metrics?.news_original_url,
    item.url,
  ].map(normalizeNewsDedupeUrl).filter(Boolean);
  return candidates[0] || "";
}

function countNewsRssRawItems(xml = "") {
  return [...String(xml || "").matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)].length;
}

function normalizeNewsKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function newsKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword).slice(0, 160);
  const compact = normalizeNewsKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function newsValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value).slice(0, 1600).toLowerCase();
  const compact = normalizeNewsKeywordText(value);
  return newsKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeNewsKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function newsKeywordMatchSource(item = {}, keyword = "") {
  if (!newsKeywordNeedles(keyword).length) return "";
  if (newsValueMatchesKeyword(item.title, keyword)) return "title";
  if (newsValueMatchesKeyword(item.description, keyword)) return "description";
  if (newsValueMatchesKeyword(item.source, keyword)) return "source";
  if (newsValueMatchesKeyword(item.url, keyword)) return "url";
  return "news_feed_search";
}

function newsTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeNewsKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeNewsKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function newsMediaNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.description || ""} ${item.content || ""} ${item.source || ""} ${item.author || ""}`;
  const evidenceTerms = newsTermMatches(text, [
    "screenshot", "proof", "evidence", "documents", "document", "records", "record", "timeline", "investigation", "report",
    "data", "filing", "court filing", "lawsuit", "complaint", "截图", "截圖", "证据", "證據", "文件", "记录", "紀錄",
    "时间线", "時間線", "调查", "調查", "報告", "报告", "訴訟", "诉讼",
  ]);
  const impactTerms = newsTermMatches(text, [
    "refund", "complaint", "customers", "users", "consumer", "loss", "damages", "outage", "breach", "privacy",
    "recall", "safety", "fraud", "scam", "boycott", "退款", "投诉", "投訴", "客诉", "客訴", "消费者", "消費者",
    "用户", "用戶", "损失", "損失", "隐私", "隱私", "泄露", "外洩", "召回", "安全", "詐騙", "诈骗", "抵制",
  ]);
  const responseTerms = newsTermMatches(text, [
    "official response", "company response", "statement", "apology", "apologized", "spokesperson", "said", "announced",
    "pledged", "promised", "corrective action", "remediation", "investigating", "responded", "官方回应", "官方回應",
    "声明", "聲明", "道歉", "致歉", "发言人", "發言人", "表示", "宣布", "承诺", "承諾", "整改", "调查中", "調查中",
  ]);
  const propagationTerms = newsTermMatches(text, [
    "viral", "spread", "spreading", "trending", "backlash", "media coverage", "social media", "widely shared",
    "public attention", "debate", "criticism", "scrutiny", "扩散", "擴散", "发酵", "發酵", "热议", "熱議",
    "社群", "社交媒体", "社交媒體", "舆论", "輿論", "关注", "關注", "批评", "批評",
  ]);
  const crisisTerms = newsTermMatches(text, [
    "crisis", "scandal", "controversy", "lawsuit", "probe", "investigation", "regulator", "enforcement", "warning",
    "recall", "breach", "fraud", "complaint", "危机", "危機", "丑闻", "醜聞", "争议", "爭議", "诉讼", "訴訟",
    "调查", "調查", "监管", "監管", "执法", "執法", "警告", "召回", "泄露", "外洩", "投诉", "投訴",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("news-media-evidence-language");
  if (impactTerms.length) reasons.push("news-media-impact-language");
  if (responseTerms.length) reasons.push("news-media-response-language");
  if (propagationTerms.length) reasons.push("news-media-propagation-language");
  if (crisisTerms.length) reasons.push("news-media-crisis-language");
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
  if (completeNarrative) reasons.push("news-media-complete-crisis-narrative");
  return {
    news_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    news_media_impact_signal: impactTerms.length ? 1 : 0,
    news_media_official_response_signal: responseTerms.length ? 1 : 0,
    news_media_propagation_signal: propagationTerms.length ? 1 : 0,
    news_media_crisis_signal: crisisTerms.length ? 1 : 0,
    news_media_semantic_signal_count: semanticSignals,
    news_media_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    news_media_evidence_terms: evidenceTerms,
    news_media_impact_terms: impactTerms,
    news_media_response_terms: responseTerms,
    news_media_propagation_terms: propagationTerms,
    news_media_crisis_terms: crisisTerms,
    news_media_narrative_reasons: reasons,
  };
}

function normalizeNewsMarkets(markets = NEWS_MARKET_PROFILES.map(profile => profile.key)) {
  const wanted = Array.isArray(markets) && markets.length ? markets : NEWS_MARKET_PROFILES.map(profile => profile.key);
  const keys = new Set(wanted.map(item => String(item || "").trim().toUpperCase()).filter(Boolean));
  const profiles = NEWS_MARKET_PROFILES.filter(profile => keys.has(profile.key));
  return profiles.length ? profiles : NEWS_MARKET_PROFILES;
}

function newsMarketQuery(keyword = "", profile = NEWS_MARKET_PROFILES[0]) {
  const term = String(keyword || "").trim();
  const marketTerms = (profile.queryTerms || []).filter(Boolean);
  if (!term) return "";
  if (!marketTerms.length) return term;
  return `${term} (${marketTerms.join(" OR ")})`;
}

function newsQueryPlans(keyword = "", deepBudget = null) {
  const term = String(keyword || "").trim();
  if (!term) return [];
  const normalizedDeepBudget = normalizeNewsDeepBudget(deepBudget);
  const plans = [{
    queryKeyword: term,
    queryMode: "base",
    queryTemplateKey: "base",
    riskTerms: [],
  }];
  if (!normalizedDeepBudget.riskQueryExpansion || normalizedDeepBudget.maxRiskQueriesPerKeyword <= 0) return plans;
  for (const template of NEWS_RISK_QUERY_TEMPLATES.slice(0, normalizedDeepBudget.maxRiskQueriesPerKeyword)) {
    plans.push({
      queryKeyword: `${term} (${template.terms.join(" OR ")})`,
      queryMode: "risk_intent",
      queryTemplateKey: template.key,
      riskTerms: template.terms,
    });
  }
  return plans;
}

function newsEngineUrls(keyword, engines = NEWS_RSS_ENGINES, markets = NEWS_MARKET_PROFILES.map(profile => profile.key), deepBudget = { riskQueryExpansion: false }) {
  const activeEngines = (Array.isArray(engines) && engines.length ? engines : NEWS_RSS_ENGINES)
    .map(engine => String(engine || "").trim())
    .filter(engine => NEWS_RSS_ENGINES.includes(engine));
  const activeMarkets = normalizeNewsMarkets(markets);
  const urls = [];
  for (const queryPlan of newsQueryPlans(keyword, deepBudget)) {
    for (const market of activeMarkets) {
      if (activeEngines.includes("google_news")) {
        const query = `${newsMarketQuery(queryPlan.queryKeyword, market)} when:3d`;
        urls.push({
          ...queryPlan,
          engine: "google_news",
          market: market.key,
          region: market.region,
          language: market.googleHl,
          url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(market.googleHl)}&gl=${encodeURIComponent(market.googleGl)}&ceid=${encodeURIComponent(market.googleCeid)}`,
        });
      }
      if (activeEngines.includes("bing_news_rss")) {
        const query = newsMarketQuery(queryPlan.queryKeyword, market);
        urls.push({
          ...queryPlan,
          engine: "bing_news_rss",
          market: market.key,
          region: market.region,
          language: market.bingMkt,
          url: `https://www.bing.com/news/search?${new URLSearchParams({ q: query, format: "rss", mkt: market.bingMkt, cc: market.bingCc }).toString()}`,
        });
      }
    }
  }
  return urls;
}

function isNewsMarketRecentItem(item = {}, { explicitMarkets = false, keyword = "" } = {}) {
  const region = String(item?.metrics?.news_region || "");
  if (explicitMarkets && region && region !== "taiwan") {
    return isRecentDate(item?.publishedAt);
  }
  if (region && region !== "taiwan") {
    const matchSource = newsKeywordMatchSource(item, keyword);
    const hasKeywordEvidence = Boolean(keyword && matchSource)
      || Boolean(item?.metrics?.news_matched_keyword)
      || Boolean(item?.metrics?.news_keyword_match_source);
    return isRecentDate(item?.publishedAt) && hasKeywordEvidence;
  }
  return isTaiwanRecentItem(item);
}

async function scrapeNewsRss(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", newsEngines = DEFAULT_GOOGLE_NEWS_ENGINES, newsMarkets = undefined, platform = "google_news", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  if (!keywords.length) return scraperResult(0);
  const maxItemsPerKeyword = budgetItems(budget);
  const normalizedDeepBudget = normalizeNewsDeepBudget(deepBudget);
  const explicitNewsMarkets = Array.isArray(newsMarkets) && newsMarkets.length > 0;

  const results = await mapWithConcurrency(keywords, KEYWORD_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const items = [];
      const seenUrls = new Set();
      for (const engineTarget of newsEngineUrls(keyword, newsEngines, newsMarkets, normalizedDeepBudget)) {
        const res = await fetchPublicSource(engineTarget.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)",
            "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, engine: engineTarget.engine, message: httpFailure(res) });
          continue;
        }

        const xml = await res.text();
        const rawItemCount = countNewsRssRawItems(xml);
        for (const item of parseRSSItems(xml, maxItemsPerKeyword - items.length)) {
          const normalized = newsItemDedupeKey(item);
          if (!normalized || seenUrls.has(normalized)) continue;
          seenUrls.add(normalized);
          items.push({
            ...item,
            metrics: {
              ...(item.metrics || {}),
              news_search_engine: engineTarget.engine,
              news_market: engineTarget.market,
              news_region: engineTarget.region,
              news_language: engineTarget.language,
              news_query_mode: engineTarget.queryMode,
              news_query_template_key: engineTarget.queryTemplateKey,
              news_query_risk_terms: engineTarget.riskTerms,
              news_search_query: engineTarget.queryKeyword,
              news_rss_raw_item_count: rawItemCount,
              news_matched_keyword: keyword,
              news_keyword_match_source: newsKeywordMatchSource(item, keyword),
              news_market_configured: explicitNewsMarkets,
              news_canonical_dedupe_url: normalized,
              news_search_scan_dedupe_key: normalized,
            },
          });
          if (items.length >= maxItemsPerKeyword) break;
        }
        if (items.length >= maxItemsPerKeyword) break;
      }

      for (const item of items) {
        if (!isAfterSince(item.publishedAt, since)) continue;
        if (!isNewsMarketRecentItem(item, { explicitMarkets: explicitNewsMarkets, keyword })) continue;
        const enriched = enrich
          ? await enrichSearchResultSummary({
              url: item.url,
              title: item.title,
              content: item.description,
            }, { proxyUrl })
          : { content: item.description.slice(0, 500), ai_summary: item.description.slice(0, 500), enriched: false };
        const content = enriched.content || item.description.slice(0, 500);
        const sentiment = analyzeSentiment(item.title + " " + content);
        const itemMetrics = {
          ...(item.metrics || {}),
          ...newsMediaNarrativeSignals({ ...item, content }),
        };
        const result = insertSentimentItem({
          platform,
          url: item.url,
          title: item.title,
          content,
          author: enriched.author || item.source,
          sentiment,
          risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
          keyword,
          keywords: [keyword],
          published_at: enriched.published_at || item.publishedAt,
          ai_summary: enriched.ai_summary,
          raw_html: enriched.raw_html || "",
          evidence: evidenceWithFailover(enriched.evidence || {}, failoverAttribution, itemMetrics),
          visual_assets: enriched.visual_assets || [],
          source_type: "scraper",
          domainControls,
          contentControls,
          failoverAttribution,
        });
        if (result.inserted) inserted++;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/GoogleNews] 爬取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeGoogleNews(keywords, options = {}) {
  return scrapeNewsRss(keywords, {
    ...options,
    newsEngines: options.newsEngines || DEFAULT_GOOGLE_NEWS_ENGINES,
    platform: options.platform || "google_news",
  });
}

export async function scrapeBingNews(keywords, options = {}) {
  return scrapeNewsRss(keywords, {
    ...options,
    newsEngines: options.newsEngines || DEFAULT_BING_NEWS_ENGINES,
    platform: options.platform || "bing_news",
  });
}

function parseRSSItems(xml, limit = 15) {
  const items = [];
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = tagValue(block, "title");
    const link = normalizeArticleUrl(tagValue(block, "link"));
    const descRaw = tagRaw(block, "description");
    const desc = stripTags(descRaw);
    const source = tagValue(block, "source");
    const sourceUrl = extractSourceUrl(block);
    const pubDate = tagValue(block, "pubDate");
    if (title && link) {
      const articleUrl = extractDescriptionArticleUrl(descRaw, link);
      const aggregatorUrl = articleUrl !== link && isAggregatorNewsUrl(link) ? link : "";
      items.push({
        title,
        url: articleUrl,
        description: desc,
        source,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
        metrics: {
          ...(aggregatorUrl ? { news_aggregator_url: aggregatorUrl } : {}),
          ...(articleUrl && articleUrl !== link ? { news_original_url: articleUrl, news_original_url_resolved: true } : {}),
          ...(sourceUrl ? { news_source_url: sourceUrl } : {}),
          ...(source ? { news_source_name: source } : {}),
        },
      });
    }
  }
  return items.slice(0, Math.min(50, Math.max(1, Number(limit) || 15)));
}

export const __test__ = {
  NEWS_MARKET_PROFILES,
  NEWS_RISK_QUERY_TEMPLATES,
  DEFAULT_GOOGLE_NEWS_ENGINES,
  DEFAULT_BING_NEWS_ENGINES,
  normalizeNewsDeepBudget,
  newsQueryPlans,
  newsEngineUrls,
  isNewsMarketRecentItem,
  normalizeNewsMarkets,
  normalizeArticleUrl,
  normalizeNewsDedupeUrl,
  newsItemDedupeKey,
  countNewsRssRawItems,
  normalizeNewsKeywordText,
  newsValueMatchesKeyword,
  newsKeywordMatchSource,
  newsMediaNarrativeSignals,
  parseRSSItems,
  budgetItems,
};
