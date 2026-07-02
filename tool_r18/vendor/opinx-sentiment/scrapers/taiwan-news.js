import { isAfterSince, isRecentDate } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";
import {
  PUBLIC_RSS_FEED_PACKS,
  __test__ as rssFeedsTest,
} from "./rss-feeds.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const FEED_CONCURRENCY = 4;
const DEFAULT_MAX_ITEMS_PER_FEED = 40;

const LEGACY_TAIWAN_NEWS_FEEDS = [
  { name: "中央社 政治", url: "https://feeds.feedburner.com/rsscna/politics" },
  { name: "中央社 生活", url: "https://feeds.feedburner.com/rsscna/lifehealth" },
  { name: "中央社 社會", url: "https://feeds.feedburner.com/rsscna/social" },
  { name: "中央社 地方", url: "https://feeds.feedburner.com/rsscna/local" },
  { name: "自由時報 即時", url: "https://news.ltn.com.tw/rss/all.xml" },
  { name: "自由時報 社會", url: "https://news.ltn.com.tw/rss/society.xml" },
  { name: "自由時報 生活", url: "https://news.ltn.com.tw/rss/life.xml" },
  { name: "自由時報 地方", url: "https://news.ltn.com.tw/rss/local.xml" },
  { name: "聯合新聞網 即時", url: "https://udn.com/rssfeed/news/2/6638?ch=news" },
  { name: "聯合新聞網 社會", url: "https://udn.com/rssfeed/news/2/6639?ch=news" },
  { name: "Yahoo奇摩新聞", url: "https://tw.news.yahoo.com/rss/" },
  { name: "ETtoday 即時", url: "https://feeds.feedburner.com/ettoday/realtime" },
  { name: "ETtoday 社會", url: "https://feeds.feedburner.com/ettoday/society" },
  { name: "三立新聞 即時", url: "https://www.setn.com/rss.aspx" },
  { name: "TVBS 新聞", url: "https://news.tvbs.com.tw/rss/news.xml" },
  { name: "公視新聞", url: "https://news.pts.org.tw/xml/newsfeed.xml" },
  { name: "鏡週刊", url: "https://www.mirrormedia.mg/rss/rss.xml" },
  { name: "關鍵評論網", url: "https://www.thenewslens.com/rss" },
  { name: "財訊", url: "https://www.wealth.com.tw/rss" },
  { name: "MoneyDJ 即時新聞", url: "https://www.moneydj.com/kmdj/RssCenter.aspx?svc=NW&fno=1&arg=X0000000" },
];

function normalizedTaiwanMediaPackFeeds() {
  return (PUBLIC_RSS_FEED_PACKS.taiwanMedia || []).map(feed => ({
    ...feed,
    sourceKey: "taiwanNews",
  }));
}

function listTaiwanNewsFeeds() {
  const merged = [];
  const seen = new Set();
  for (const feed of [...LEGACY_TAIWAN_NEWS_FEEDS, ...normalizedTaiwanMediaPackFeeds()]) {
    const key = String(feed?.url || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...feed });
  }
  return merged;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value, max = 1000) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function tagValue(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1], 1200) : "";
}

function linkValue(block) {
  const direct = tagValue(block, "link");
  if (direct) return direct;
  const href = String(block || "").match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return href ? decodeHtml(href[1]).trim() : "";
}

function normalizePublishedAt(value) {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function budgetItemsPerFeed(budget = {}) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_FEED));
  return Math.max(1, Math.min(100, Number.isFinite(value) ? value : DEFAULT_MAX_ITEMS_PER_FEED));
}

function parseFeedItems(xml, feedName, { maxItems = DEFAULT_MAX_ITEMS_PER_FEED } = {}) {
  const source = String(xml || "");
  const blocks = [
    ...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi),
    ...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi),
  ].map(match => match[0]);

  const items = [];
  for (const block of blocks) {
    const title = tagValue(block, "title");
    const url = linkValue(block);
    const content = tagValue(block, "description")
      || tagValue(block, "summary")
      || tagValue(block, "content:encoded")
      || tagValue(block, "content");
    const publishedAt = normalizePublishedAt(
      tagValue(block, "pubDate")
      || tagValue(block, "published")
      || tagValue(block, "updated")
      || tagValue(block, "dc:date")
    );
    if (!title || !url) continue;
    items.push({
      title,
      url,
      content,
      publishedAt,
      author: feedName,
    });
    if (items.length >= maxItems) break;
  }
  return items;
}

function countTaiwanNewsFeedRawItems(xml) {
  const source = String(xml || "");
  return [
    ...source.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi),
    ...source.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi),
  ].length;
}

function selectTaiwanNewsChildSitemapUrls(urls = [], feed = {}) {
  const candidates = Array.isArray(urls)
    ? urls.map(url => String(url || "").trim()).filter(Boolean)
    : [];
  if (!candidates.length) return [];
  const strategy = String(feed?.sitemapChildStrategy || "").toLowerCase();
  const limitRaw = Number(feed?.childSitemapLimit || 1);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.round(limitRaw))) : 1;
  if (strategy === "all") return candidates.slice(0, limit);
  if (strategy === "first") return candidates.slice(0, limit);
  return candidates.slice(-limit);
}

function normalizeTaiwanNewsKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function taiwanNewsKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword, 160);
  const compact = normalizeTaiwanNewsKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function taiwanNewsValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value, 1600).toLowerCase();
  const compact = normalizeTaiwanNewsKeywordText(value);
  return taiwanNewsKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeTaiwanNewsKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function matchKeyword(item, keywords) {
  const text = `${item.title || ""} ${item.content || ""}`;
  return keywords.find(keyword => taiwanNewsValueMatchesKeyword(text, keyword)) || "";
}

function taiwanNewsKeywordMatchSource(item = {}, keyword = "") {
  if (!taiwanNewsKeywordNeedles(keyword).length) return "";
  if (taiwanNewsValueMatchesKeyword(item.title, keyword)) return "title";
  if (taiwanNewsValueMatchesKeyword(item.content, keyword)) return "content";
  return "feed_search";
}

function normalizeTaiwanNewsDedupeUrl(rawUrl = "") {
  const raw = decodeHtml(rawUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ocid", "ref"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function taiwanNewsDedupeKey(item = {}) {
  return normalizeTaiwanNewsDedupeUrl(item.url || "");
}

function taiwanNewsTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeTaiwanNewsKeywordText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeTaiwanNewsKeywordText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function taiwanNewsMediaNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = taiwanNewsTermMatches(text, [
    "截圖", "截图", "錄影", "录像", "證據", "证据", "憑證", "凭证", "文件", "發票", "发票",
    "訂單", "订单", "時間線", "时间线", "調查", "调查", "爆料", "實測", "实测", "proof", "evidence", "timeline",
  ]);
  const impactTerms = taiwanNewsTermMatches(text, [
    "退款", "拒退", "客服", "款項", "款项", "消費者", "消费者", "用戶", "用户", "受害", "損失", "损失",
    "風險", "风险", "詐騙", "诈骗", "炎上", "抵制", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = taiwanNewsTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回覆", "客服回复",
    "客服回應", "客服回应", "道歉", "致歉", "澄清", "說明", "说明", "承諾", "承诺", "official response", "statement", "apology",
  ]);
  const propagationTerms = taiwanNewsTermMatches(text, [
    "擴散", "扩散", "延燒", "延烧", "發酵", "发酵", "熱議", "热议", "轉傳", "转传", "社群", "社群平台",
    "媒體報導", "媒体报道", "輿論", "舆论", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = taiwanNewsTermMatches(text, [
    "投訴", "投诉", "客訴", "客诉", "退款", "拒退", "詐騙", "诈骗", "資安", "资安", "外洩", "泄露",
    "召回", "調查", "调查", "訴訟", "诉讼", "危機", "危机", "complaint", "refund", "scam", "breach", "crisis",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("taiwan-news-evidence-language");
  if (impactTerms.length) reasons.push("taiwan-news-impact-language");
  if (responseTerms.length) reasons.push("taiwan-news-official-response-language");
  if (propagationTerms.length) reasons.push("taiwan-news-propagation-language");
  if (crisisTerms.length) reasons.push("taiwan-news-crisis-language");
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
    && crisisTerms.length > 0
    && propagationTerms.length > 0
    && semanticSignals >= 5;
  if (completeNarrative) reasons.push("taiwan-news-complete-media-crisis-narrative");
  return {
    taiwan_news_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    taiwan_news_media_impact_signal: impactTerms.length ? 1 : 0,
    taiwan_news_media_official_response_signal: responseTerms.length ? 1 : 0,
    taiwan_news_media_propagation_signal: propagationTerms.length ? 1 : 0,
    taiwan_news_media_crisis_signal: crisisTerms.length ? 1 : 0,
    taiwan_news_media_semantic_signal_count: semanticSignals,
    taiwan_news_complete_media_crisis_narrative_signal: completeNarrative ? 1 : 0,
    taiwan_news_media_evidence_terms: evidenceTerms,
    taiwan_news_media_impact_terms: impactTerms,
    taiwan_news_media_response_terms: responseTerms,
    taiwan_news_media_propagation_terms: propagationTerms,
    taiwan_news_media_crisis_terms: crisisTerms,
    taiwan_news_media_narrative_reasons: reasons,
  };
}

function taiwanNewsItemQualityScore(item = {}) {
  let score = 35;
  const contentLength = stripTags(`${item.title || ""} ${item.content || ""}`, 5000).length;
  if (item.url) score += 10;
  if (contentLength >= 120) score += 18;
  else if (contentLength >= 50) score += 8;
  if (item.author || item.source_name) score += 6;
  if (Array.isArray(item.categories) && item.categories.length) score += 6;
  if (item.guid) score += 5;
  if (item.media_url) score += 5;
  if (item.feed_item_format && item.feed_item_format !== "rss") score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function taiwanNewsItemRelevanceScore(item = {}, keyword = "") {
  const matchSource = taiwanNewsKeywordMatchSource(item, keyword);
  const narrativeSignals = taiwanNewsMediaNarrativeSignals(item);
  const semanticBoost = Math.min(20, Number(narrativeSignals.taiwan_news_media_semantic_signal_count || 0) * 4);
  const base = {
    title: 76,
    content: 68,
    author: 58,
    category: 58,
    url: 52,
    feed_search: 48,
  }[matchSource] || 42;
  return Math.max(0, Math.min(100, Math.round(base + semanticBoost)));
}

function taiwanNewsSourceWeightTier(item = {}) {
  const sourceFamily = String(item.source_family || "").toLowerCase();
  const tags = new Set((Array.isArray(item.feed_tags) ? item.feed_tags : []).map(tag => String(tag || "").toLowerCase()));
  if (item.regulatory || tags.has("official") || sourceFamily.includes("regulatory")) return "official-regulatory";
  if (sourceFamily.includes("business") || tags.has("finance") || tags.has("business")) return "regional-business-media";
  if (tags.has("google-news-index")) return "regional-media-index";
  return "regional-priority-media";
}

function taiwanNewsEvidenceDepthProfile(item = {}, { enrichmentMetrics = {}, narrativeSignals = {}, sourceWeightTier = "" } = {}) {
  const reasons = [];
  let score = 18;
  const contentLength = stripTags(`${item.title || ""} ${item.content || ""}`, 8000).length;
  const articleBodyLength = Number(enrichmentMetrics.article_body_text_length || 0);
  const articleBodyQuality = Number(enrichmentMetrics.article_body_quality_score || 0);
  const semanticSignalCount = Number(narrativeSignals.taiwan_news_media_semantic_signal_count || 0);
  if (contentLength >= 1200) {
    score += 28;
    reasons.push("long-content");
  } else if (contentLength >= 500) {
    score += 20;
    reasons.push("medium-content");
  } else if (contentLength >= 160) {
    score += 12;
    reasons.push("short-content");
  }
  if (articleBodyLength >= 1200 || articleBodyQuality >= 70) {
    score += 18;
    reasons.push("article-body-extracted");
  } else if (articleBodyLength >= 400 || articleBodyQuality >= 45) {
    score += 10;
    reasons.push("article-body-partial");
  }
  if (item.author || item.feed_item_author) {
    score += 6;
    reasons.push("has-author");
  }
  if (Array.isArray(item.categories) && item.categories.length) {
    score += 6;
    reasons.push("has-categories");
  }
  if (item.media_url || enrichmentMetrics.has_image) {
    score += 5;
    reasons.push("has-visual-context");
  }
  if (semanticSignalCount >= 4) {
    score += 14;
    reasons.push("multi-signal-media-crisis-narrative");
  } else if (semanticSignalCount >= 2) {
    score += 8;
    reasons.push("partial-media-crisis-narrative");
  }
  if (Number(enrichmentMetrics.propagation_followup_link_count || 0) > 0) {
    score += 6;
    reasons.push("has-propagation-followups");
  }
  if (["regional-priority-media", "regional-business-media", "official-regulatory"].includes(sourceWeightTier)) {
    score += 8;
    reasons.push("trusted-taiwan-media-source");
  } else if (sourceWeightTier === "regional-media-index") {
    score += 4;
    reasons.push("trusted-taiwan-media-index");
  }
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: bounded,
    bucket: bounded >= 75 ? "deep" : bounded >= 55 ? "usable" : bounded >= 35 ? "thin" : "shallow",
    reasons: [...new Set(reasons)].slice(0, 12),
  };
}

function evidenceWithFailover(evidence = {}, failoverAttribution = []) {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  if (!attribution.length) return evidence || {};
  return {
    ...(evidence || {}),
    metrics: {
      ...(evidence?.metrics || {}),
      failover_attribution: attribution,
      failover_from_sources: [...new Set(attribution.map(item => item?.fromSource).filter(Boolean))],
    },
  };
}

async function insertNewsItem(item, { keyword, proxyUrl, enrich, rawItemCount = 0, domainControls = {}, contentControls = {}, failoverAttribution = [], seenItemUrls = null }) {
  const dedupeKey = taiwanNewsDedupeKey(item);
  if (!dedupeKey) return 0;
  if (seenItemUrls instanceof Set) {
    if (seenItemUrls.has(dedupeKey)) return 0;
    seenItemUrls.add(dedupeKey);
  }
  const fallback = item.content || "";
  const enriched = enrich
    ? await enrichSearchResultSummary(item, { proxyUrl })
    : { content: fallback, ai_summary: fallback, enriched: false };
  const content = enriched.content || fallback;
  const sentiment = analyzeSentiment(`${item.title} ${content}`);
  const scoredItem = { ...item, content, author: enriched.author || item.author };
  const narrativeSignals = taiwanNewsMediaNarrativeSignals(scoredItem);
  const qualityScore = taiwanNewsItemQualityScore(scoredItem);
  const relevanceScore = taiwanNewsItemRelevanceScore(scoredItem, keyword);
  const sourceWeightTier = taiwanNewsSourceWeightTier(item);
  const depthProfile = taiwanNewsEvidenceDepthProfile(scoredItem, {
    enrichmentMetrics: enriched.evidence?.metrics || {},
    narrativeSignals,
    sourceWeightTier,
  });
  const result = insertSentimentItem({
    platform: "taiwan_news",
    url: item.url,
    title: item.title,
    content,
    author: enriched.author || item.author,
    sentiment,
    risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
    keyword,
    keywords: [keyword],
    published_at: enriched.published_at || item.publishedAt,
    ai_summary: enriched.ai_summary,
    raw_html: enriched.raw_html || "",
    evidence: evidenceWithFailover({
      ...(enriched.evidence || {}),
      source_key: "taiwanNews",
      evidence_type: enriched.evidence?.evidence_type || "taiwan_news_feed_item",
      metrics: {
        ...(enriched.evidence?.metrics || {}),
        ...(item.metrics || {}),
        taiwan_news_feed_name: item.feed_name || item.author || "",
        taiwan_news_feed_url: item.feed_url || "",
        taiwan_news_source_name: item.source_name || item.metrics?.rss_source_name || "",
        taiwan_news_base_feed_name: item.base_feed_name || "",
        taiwan_news_base_feed_url: item.base_feed_url || "",
        taiwan_news_keyword_search_keyword: item.keyword_search_keyword || "",
        taiwan_news_feed_pack: item.feed_pack || "",
        taiwan_news_feed_tags: Array.isArray(item.feed_tags) ? item.feed_tags : [],
        taiwan_news_source_family: item.source_family || "",
        taiwan_news_regulatory: Boolean(item.regulatory),
        taiwan_news_feed_item_format: item.feed_item_format || "",
        taiwan_news_feed_item_author: item.feed_item_author || item.author || "",
        taiwan_news_original_url: item.metrics?.rss_original_url || "",
        taiwan_news_original_url_resolved: Boolean(item.metrics?.rss_original_url_resolved),
        taiwan_news_aggregator_url: item.metrics?.rss_aggregator_url || "",
        taiwan_news_feed_item_categories: Array.isArray(item.categories) ? item.categories : [],
        taiwan_news_feed_item_media_url: item.media_url || "",
        taiwan_news_feed_raw_item_count: rawItemCount,
        taiwan_news_matched_keyword: keyword || "",
        taiwan_news_keyword_match_source: taiwanNewsKeywordMatchSource(item, keyword),
        taiwan_news_relevance_score: relevanceScore,
        taiwan_news_quality_score: qualityScore,
        taiwan_news_evidence_depth_score: depthProfile.score,
        taiwan_news_evidence_depth_bucket: depthProfile.bucket,
        taiwan_news_evidence_depth_reasons: depthProfile.reasons,
        evidence_depth_score: depthProfile.score,
        source_weight_tier: sourceWeightTier,
        taiwan_news_canonical_dedupe_url: dedupeKey,
        taiwan_news_search_scan_dedupe_key: dedupeKey,
        ...narrativeSignals,
      },
    }, failoverAttribution),
    visual_assets: [
      ...(enriched.visual_assets || []),
      ...(item.media_url ? [{
        source_key: "taiwanNews",
        asset_type: "feed-media",
        image_url: item.media_url,
        metrics: {
          feed_name: item.feed_name || item.author || "",
          feed_url: item.feed_url || "",
          source_name: item.source_name || item.metrics?.rss_source_name || "",
          base_feed_name: item.base_feed_name || "",
          base_feed_url: item.base_feed_url || "",
          keyword_search_keyword: item.keyword_search_keyword || "",
          feed_pack: item.feed_pack || "",
          source_family: item.source_family || "",
          feed_item_format: item.feed_item_format || "",
        },
      }] : []),
    ],
    source_type: "scraper",
    domainControls,
    contentControls,
    failoverAttribution,
  });
  return result.inserted ? 1 : 0;
}

export async function scrapeTaiwanNewsFeeds(keywords, { proxyUrl = "", enrich = false, budget = {}, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const maxItems = budgetItemsPerFeed(budget);
  const seenItemUrls = new Set();
  const feeds = rssFeedsTest.expandFeedsForKeywords(listTaiwanNewsFeeds(), normalizedKeywords);

  const results = await mapWithConcurrency(feeds, FEED_CONCURRENCY, async (feed) => {
    let inserted = 0;
    const failures = [];
    try {
      const res = await fetchPublicSource(feed.url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);
      if (!res.ok) {
        failures.push({ target: feed.name, message: httpFailure(res) });
        return { inserted, failures };
      }
      const text = await res.text();
      const rawItemCount = rssFeedsTest.countConfiguredFeedRawItems(text, feed) ?? countTaiwanNewsFeedRawItems(text);
      let payloads = [{
        feed,
        rawItemCount,
        items: rssFeedsTest.parseRssFeedItems(text, feed, { maxItems }),
      }];
      if (!payloads[0].items.length) {
        const childUrls = selectTaiwanNewsChildSitemapUrls(rssFeedsTest.parseSitemapIndexUrls(text), feed);
        for (const childUrl of childUrls) {
          try {
            const childRes = await fetchPublicSource(childUrl, {
              headers: {
                "User-Agent": USER_AGENT,
                "Accept": "application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
                "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
              },
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            }, proxyUrl);
            if (!childRes.ok) {
              failures.push({ target: `${feed.name} child`, message: httpFailure(childRes) });
              continue;
            }
            const childText = await childRes.text();
            const childFeed = { ...feed, url: childUrl };
            const childItems = rssFeedsTest.parseRssFeedItems(childText, childFeed, { maxItems });
            if (!childItems.length) continue;
            payloads = [{
              feed: childFeed,
              rawItemCount: rssFeedsTest.countConfiguredFeedRawItems(childText, childFeed) ?? countTaiwanNewsFeedRawItems(childText),
              items: childItems,
            }];
            break;
          } catch (childError) {
            failures.push({ target: `${feed.name} child`, message: formatSourceError(childError, proxyUrl) });
          }
        }
      }
      for (const payload of payloads) {
        for (const item of payload.items) {
          const keyword = matchKeyword(item, normalizedKeywords);
          if (!isAfterSince(item.publishedAt, since)) continue;
          if (!keyword || !isRecentDate(item.publishedAt)) continue;
          inserted += await insertNewsItem({
            ...item,
            feed_name: payload.feed.name || "",
            feed_url: payload.feed.url || "",
            source_name: item.metrics?.rss_source_name || "",
            base_feed_url: payload.feed.baseFeedUrl || "",
            base_feed_name: payload.feed.baseFeedName || "",
            keyword_search_keyword: payload.feed.keywordSearchKeyword || "",
            feed_pack: payload.feed.pack || "",
            feed_tags: Array.isArray(payload.feed.tags) ? payload.feed.tags : [],
            source_family: payload.feed.sourceFamily || "",
            regulatory: Boolean(payload.feed.regulatory),
          }, { keyword, proxyUrl, enrich, rawItemCount: payload.rawItemCount, domainControls, contentControls, failoverAttribution, seenItemUrls });
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ target: feed.name, message });
      console.warn(`[CRM/TaiwanNews] RSS 抓取失敗 target=${feed.name}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  parseFeedItems,
  countTaiwanNewsFeedRawItems,
  normalizeTaiwanNewsKeywordText,
  taiwanNewsValueMatchesKeyword,
  matchKeyword,
  taiwanNewsKeywordMatchSource,
  budgetItemsPerFeed,
  listTaiwanNewsFeeds,
  normalizeTaiwanNewsDedupeUrl,
  taiwanNewsDedupeKey,
  taiwanNewsMediaNarrativeSignals,
  taiwanNewsEvidenceDepthProfile,
};
