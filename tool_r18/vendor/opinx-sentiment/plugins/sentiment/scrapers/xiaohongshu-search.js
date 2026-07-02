import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { countBaiduRawResults, parseBaiduSearchResults } from "./baidu-search.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const SITE_SCOPES = ["xiaohongshu.com/explore", "xiaohongshu.com/discovery/item", "m.xiaohongshu.com/discovery/item"];

function cleanText(value, max = 1200) {
  return String(value || "")
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

function normalizeXiaohongshuUrl(value = "") {
  const raw = cleanText(value, 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "xiaohongshu.com" && host !== "m.xiaohongshu.com") return "";
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "xhsshare", "appuid", "apptime", "from"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeXiaohongshuDedupeUrl(value = "") {
  const normalized = normalizeXiaohongshuUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "xhsshare", "appuid", "apptime", "from"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return normalized.toLowerCase();
  }
}

function normalizeXiaohongshuDirectUrls(values = [], limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const url = normalizeXiaohongshuDedupeUrl(value);
    if (!url || !isConcreteXiaohongshuUrl(url)) continue;
    const reference = xiaohongshuNoteReference(url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      originalUrl: normalizeXiaohongshuUrl(value) || url,
      noteId: reference.noteId,
      dedupeKey: url,
    });
    if (out.length >= Math.max(1, Number(limit) || 20)) break;
  }
  return out;
}

function xiaohongshuSearchDedupeKey(item = {}) {
  return normalizeXiaohongshuDedupeUrl(item?.url || "");
}

function normalizeXiaohongshuKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function xiaohongshuKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeXiaohongshuKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function xiaohongshuValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeXiaohongshuKeywordText(value);
  return xiaohongshuKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeXiaohongshuKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function xiaohongshuKeywordMatchSource(item = {}, keyword = "") {
  if (!xiaohongshuKeywordNeedles(keyword).length) return "";
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
    ["search_scope", metrics.search_scope],
    ["xiaohongshu_evidence_kind", metrics.xiaohongshu_evidence_kind],
    ["public_search_engine", metrics.public_search_engine],
  ];
  const match = fields.find(([, value]) => xiaohongshuValueMatchesKeyword(value, keyword));
  return match ? match[0] : "";
}

function xiaohongshuKeywordDiagnostics(item = {}, keyword = "") {
  return {
    xiaohongshu_matched_keyword: cleanText(keyword, 160),
    xiaohongshu_keyword_match_source: xiaohongshuKeywordMatchSource(item, keyword),
  };
}

function isConcreteXiaohongshuUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "xiaohongshu.com" && host !== "m.xiaohongshu.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    if (/^(search|login|signup|user|profile|explore\/search)$/i.test(segments.join("/"))) return false;
    if (segments[0] === "explore") return /^[A-Za-z0-9_-]{6,}$/.test(segments[1] || "");
    if (segments[0] === "discovery" && segments[1] === "item") return /^[A-Za-z0-9_-]{6,}$/.test(segments[2] || "");
    return false;
  } catch {
    return false;
  }
}

function xiaohongshuEvidenceKind(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "discovery" && segments[1] === "item") return "note";
    if (segments[0] === "explore") return "note";
  } catch {
    return "";
  }
  return "";
}

function xiaohongshuNoteReference(url = "") {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] === "explore") return { noteId: segments[1] || "" };
    if (segments[0] === "discovery" && segments[1] === "item") return { noteId: segments[2] || "" };
  } catch {
    return { noteId: "" };
  }
  return { noteId: "" };
}

function stripHtml(value = "", max = 1200) {
  return cleanText(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">"), max);
}

function extractMetaContent(html = "", names = []) {
  const text = String(html || "");
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
    const match = pattern.exec(text);
    if (match?.[1]) return stripHtml(match[1], 1200);
    const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i");
    const reverseMatch = reversePattern.exec(text);
    if (reverseMatch?.[1]) return stripHtml(reverseMatch[1], 1200);
  }
  return "";
}

function parseXiaohongshuDirectNotePage(html = "", direct = {}, keyword = "") {
  const url = normalizeXiaohongshuDedupeUrl(direct.url || direct.originalUrl || "");
  if (!url || !isConcreteXiaohongshuUrl(url)) return null;
  const reference = xiaohongshuNoteReference(url);
  const rawTitle = extractMetaContent(html, ["og:title", "twitter:title"])
    || stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""))?.[1] || "", 240);
  const title = rawTitle
    .replace(/\s*[-_]\s*小红书.*$/i, "")
    .replace(/\s*[-_]\s*小紅書.*$/i, "")
    .trim()
    || `小红书笔记 ${reference.noteId || url}`;
  const content = extractMetaContent(html, ["description", "og:description", "twitter:description"])
    || stripHtml(html, 1600)
    || `${keyword || ""} 小红书直达笔记 ${reference.noteId || url}`;
  const item = {
    url,
    title,
    content,
    author: extractMetaContent(html, ["author"]) || "小红书直达笔记",
    publishedAt: new Date().toISOString(),
    rawHtml: html,
    metrics: {
      source_kind: "xiaohongshu_direct_url",
      collection_mode: "xiaohongshu_direct_url",
      deep_collector: "xiaohongshu-direct-url",
      direct_url: url,
      xiaohongshu_direct_url: url,
      xiaohongshu_original_direct_url: direct.originalUrl || direct.url || url,
      xiaohongshu_direct_url_signal: 1,
      xiaohongshu_evidence_kind: "note",
      xiaohongshu_note_id: reference.noteId,
      disableContentFingerprintDedupe: true,
    },
  };
  item.metrics = {
    ...(item.metrics || {}),
    ...xiaohongshuNoteRiskSignals(item, keyword),
  };
  return item;
}

function xiaohongshuNoteSignals(text = "") {
  const source = cleanText(text, 1800).toLowerCase();
  const avoidance = /避雷|踩雷|黑名单|黑名單|不要买|不要買|劝退|勸退|慎买|慎買|拔草|\bavoid|warning|boycott\b/.test(source);
  const complaint = /投诉|投訴|吐槽|维权|維權|退款|退货|退貨|售后|售後|客服|翻车|翻車|\bcomplaint|refund|chargeback|dispute|support\b/.test(source);
  const comment = /评论|評論|评论区|評論區|留言|回复|回覆|跟帖|热评|熱評|\bcomment|reply|replies|discussion\b/.test(source);
  const evidence = /截图|截圖|晒图|曬圖|凭证|憑證|证据|證據|聊天记录|聊天紀錄|订单|訂單|小票|\bscreenshot|receipt|evidence|proof\b/.test(source);
  const amplification = /扩散|擴散|热议|熱議|发酵|發酵|转发|轉發|分享|收藏|刷屏|爆料|曝光|\bviral|spreading|trending|shared|saved\b/.test(source);
  const reasons = [];
  if (avoidance) reasons.push("avoidance-language");
  if (complaint) reasons.push("complaint-language");
  if (comment) reasons.push("comment-discussion-language");
  if (evidence) reasons.push("screenshot-evidence-language");
  if (amplification) reasons.push("amplification-language");
  return {
    xiaohongshu_avoidance_signal: avoidance ? 1 : 0,
    xiaohongshu_complaint_signal: complaint ? 1 : 0,
    xiaohongshu_comment_signal: comment ? 1 : 0,
    xiaohongshu_evidence_signal: evidence ? 1 : 0,
    xiaohongshu_amplification_signal: amplification ? 1 : 0,
    xiaohongshu_note_signal_count: reasons.length,
    xiaohongshu_note_signal_reasons: reasons,
  };
}

function xiaohongshuNoteRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function xiaohongshuNoteRiskSignals(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const text = `${item.title || ""} ${item.content || ""} ${keyword || ""}`.toLowerCase();
  const noteSignals = xiaohongshuNoteSignals(text);
  const impactTerms = [
    "退款", "拒退", "退货", "退貨", "客服", "售后", "售後", "维权", "維權",
    "避雷", "踩雷", "翻车", "翻車", "詐騙", "诈骗", "差评", "差評",
    "refund", "chargeback", "customer support", "support delay", "dispute", "avoid", "warning", "scam", "fraud",
  ].filter(term => text.includes(term.toLowerCase()));
  const responseTerms = [
    "客服回應", "客服回应", "官方回應", "官方回应", "官方說明", "官方说明",
    "商家回應", "商家回应", "品牌回應", "品牌回应", "道歉", "致歉", "澄清", "後續", "后续",
    "customer support response", "official response", "business response", "brand response", "apology", "clarification", "follow-up",
  ].filter(term => text.includes(term.toLowerCase()));
  const rawResultCount = Math.max(0, Number(metrics.xiaohongshu_search_raw_result_count || 0));
  const isNote = metrics.xiaohongshu_evidence_kind === "note" || xiaohongshuEvidenceKind(item.url) === "note";
  const enriched = Boolean(metrics.enriched || metrics.content_enriched || metrics.article_body_length || metrics.raw_html_length);
  const titleMatch = xiaohongshuKeywordMatchSource(item, keyword) === "title";
  const reasons = [...(noteSignals.xiaohongshu_note_signal_reasons || [])];
  if (isNote) reasons.push("concrete-note-url");
  if (rawResultCount > 1) reasons.push("multi-result-search-context");
  if (enriched) reasons.push("deep-page-evidence");
  if (titleMatch) reasons.push("keyword-title-match");
  if (impactTerms.length) reasons.push("impact-language");
  if (responseTerms.length) reasons.push("response-language");

  const semanticSignalCount = [
    noteSignals.xiaohongshu_avoidance_signal,
    noteSignals.xiaohongshu_complaint_signal,
    noteSignals.xiaohongshu_comment_signal,
    noteSignals.xiaohongshu_evidence_signal,
    noteSignals.xiaohongshu_amplification_signal,
    impactTerms.length,
    responseTerms.length,
    isNote,
    rawResultCount > 1,
    enriched,
    titleMatch,
  ].filter(Boolean).length;
  const completeNarrative = isNote
    && noteSignals.xiaohongshu_avoidance_signal
    && noteSignals.xiaohongshu_complaint_signal
    && impactTerms.length > 0
    && noteSignals.xiaohongshu_evidence_signal
    && noteSignals.xiaohongshu_amplification_signal
    && semanticSignalCount >= 7;

  const score = Math.min(100, Math.max(0,
    (isNote ? 12 : 0)
    + (noteSignals.xiaohongshu_avoidance_signal ? 14 : 0)
    + (noteSignals.xiaohongshu_complaint_signal ? 18 : 0)
    + (noteSignals.xiaohongshu_comment_signal ? 10 : 0)
    + (noteSignals.xiaohongshu_evidence_signal ? 16 : 0)
    + (noteSignals.xiaohongshu_amplification_signal ? 16 : 0)
    + (impactTerms.length ? 10 : 0)
    + (responseTerms.length ? 8 : 0)
    + (completeNarrative ? 12 : 0)
    + (rawResultCount > 1 ? 8 : 0)
    + (enriched ? 8 : 0)
    + (titleMatch ? 8 : 0)
  ));

  return {
    ...noteSignals,
    xiaohongshu_note_concrete_signal: isNote ? 1 : 0,
    xiaohongshu_note_deep_evidence_signal: enriched ? 1 : 0,
    xiaohongshu_impact_language_signal: impactTerms.length ? 1 : 0,
    xiaohongshu_response_language_signal: responseTerms.length ? 1 : 0,
    xiaohongshu_complete_note_crisis_narrative_signal: completeNarrative ? 1 : 0,
    xiaohongshu_impact_terms: [...new Set(impactTerms)].slice(0, 12),
    xiaohongshu_response_terms: [...new Set(responseTerms)].slice(0, 12),
    xiaohongshu_semantic_signal_count: semanticSignalCount,
    xiaohongshu_note_risk_score: score,
    xiaohongshu_note_risk_bucket: xiaohongshuNoteRiskBucket(score),
    xiaohongshu_note_risk_signal_count: reasons.length,
    xiaohongshu_note_risk_reasons: [...new Set(reasons)],
  };
}

export function parseXiaohongshuSearchResults(html, keyword = "", { limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  return parseBaiduSearchResults(html, keyword, {
    limit,
    since,
    sourceKind: "xiaohongshu",
  }).map(item => {
    const url = normalizeXiaohongshuUrl(item.url);
    if (!url || !isConcreteXiaohongshuUrl(url)) return null;
    const reference = xiaohongshuNoteReference(url);
    const result = {
      ...item,
      url,
      author: item.author && !/百度/.test(item.author) ? item.author : "小紅書公開搜索",
      metrics: {
        ...(item.metrics || {}),
        public_search_engine: "baidu_site_xiaohongshu",
        source_kind: "xiaohongshu_public_search",
        xiaohongshu_evidence_kind: xiaohongshuEvidenceKind(url),
        xiaohongshu_note_id: reference.noteId,
        collection_mode: "site_xiaohongshu_public_search",
      },
    };
    result.metrics = {
      ...(result.metrics || {}),
      ...xiaohongshuNoteRiskSignals(result, keyword),
    };
    return result;
  }).filter(Boolean);
}

async function insertXiaohongshuItems(items, { keyword, proxyUrl = "", enrich = true, maxDeepPages = 0, domainControls = {}, contentControls = {}, seenItemUrls = null }) {
  let inserted = 0;
  let deepPagesUsed = 0;
  for (const item of items) {
    const dedupeKey = xiaohongshuSearchDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls?.has(dedupeKey)) continue;
    seenItemUrls?.add(dedupeKey);
    const shouldEnrich = enrich && deepPagesUsed < maxDeepPages;
    const enriched = shouldEnrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: item.content, ai_summary: item.content, enriched: false };
    if (shouldEnrich) deepPagesUsed += 1;
    const content = enriched.content || item.content || "";
    const reference = xiaohongshuNoteReference(item.url);
    const noteSignals = xiaohongshuNoteSignals(`${item.title} ${content}`);
    const evidenceMetrics = {
      ...(item.metrics || {}),
      ...(enriched.evidence?.metrics || {}),
    };
    const riskSignals = xiaohongshuNoteRiskSignals({
      ...item,
      content,
      author: enriched.author || item.author,
      metrics: evidenceMetrics,
    }, keyword);
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "xiaohongshu",
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
      raw_html: enriched.raw_html || item.rawHtml || "",
      evidence: {
        ...(enriched.evidence || {}),
        evidence_type: enriched.evidence?.evidence_type || (item.metrics?.collection_mode === "xiaohongshu_direct_url" ? "xiaohongshu_direct_note" : "xiaohongshu_public_search_result"),
        metrics: {
          ...evidenceMetrics,
          ...xiaohongshuKeywordDiagnostics({
            ...item,
            content,
            author: enriched.author || item.author,
            metrics: evidenceMetrics,
          }, keyword),
          xiaohongshu_note_id: reference.noteId,
          ...noteSignals,
          ...riskSignals,
          xiaohongshu_canonical_dedupe_url: dedupeKey,
          xiaohongshu_search_scan_dedupe_key: dedupeKey,
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

export async function scrapeXiaohongshuSearch(keywords, { proxyUrl = "", enrich = true, budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeXiaohongshuDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const { maxItemsPerKeyword, maxPagesPerKeyword } = normalizeBudget(budget);
  const maxDeepPages = deepPagesPerKeyword(deepBudget);
  let inserted = 0;
  const failures = [];
  const seenItemUrls = new Set();

  for (const keyword of normalizedKeywords.length ? normalizedKeywords : [""]) {
    let keywordInserted = 0;
    for (const direct of normalizedDirectUrls) {
      const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
      if (remaining <= 0) break;
      try {
        const res = await fetchPublicSource(direct.url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, url: direct.url, message: httpFailure(res) });
          continue;
        }
        const html = await res.text();
        const item = parseXiaohongshuDirectNotePage(html, direct, keyword);
        if (!item || !isAfterSince(item.publishedAt, since)) continue;
        const count = await insertXiaohongshuItems([item], {
          keyword,
          proxyUrl,
          enrich: false,
          maxDeepPages: 0,
          domainControls,
          contentControls,
          seenItemUrls,
        });
        inserted += count;
        keywordInserted += count;
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, url: direct.url, message });
        console.warn(`[Sentiment/Xiaohongshu] 直达笔记抓取失敗 url=${direct.url}: ${message}`);
      }
    }
    for (const scope of SITE_SCOPES) {
      if (keywordInserted >= maxItemsPerKeyword) break;
      for (let page = 0; page < maxPagesPerKeyword; page += 1) {
        const remaining = Math.max(0, maxItemsPerKeyword - keywordInserted);
        if (remaining <= 0) break;
        const query = `site:${scope} ${keyword}`;
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${page * 10}&ie=utf-8`;
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
            failures.push({ keyword, scope, message: httpFailure(res) });
            continue;
          }
          const html = await res.text();
          const rawResultCount = countBaiduRawResults(html);
	          const items = parseXiaohongshuSearchResults(html, keyword, {
	            limit: remaining,
	            since,
	          }).map(item => ({
	            ...item,
            metrics: {
              ...(item.metrics || {}),
              search_scope: scope,
              xiaohongshu_search_page: page + 1,
	              xiaohongshu_search_offset: page * 10,
	              xiaohongshu_search_raw_result_count: rawResultCount,
	            },
	          })).map(item => ({
	            ...item,
	            metrics: {
	              ...(item.metrics || {}),
	              ...xiaohongshuNoteRiskSignals(item, keyword),
	            },
	          }));
          const count = await insertXiaohongshuItems(items, {
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
          console.warn(`[Sentiment/Xiaohongshu] 抓取失敗 keyword=${keyword} scope=${scope}: ${message}`);
        }
      }
    }
  }
  return scraperResult(inserted, failures);
}

export const __test__ = {
  isConcreteXiaohongshuUrl,
  normalizeBudget,
  normalizeXiaohongshuDirectUrls,
  normalizeXiaohongshuDedupeUrl,
  normalizeXiaohongshuUrl,
  parseXiaohongshuDirectNotePage,
  parseXiaohongshuSearchResults,
  xiaohongshuSearchDedupeKey,
  normalizeXiaohongshuKeywordText,
  xiaohongshuValueMatchesKeyword,
  xiaohongshuKeywordMatchSource,
  xiaohongshuKeywordDiagnostics,
  xiaohongshuEvidenceKind,
  xiaohongshuNoteReference,
  xiaohongshuNoteSignals,
  xiaohongshuNoteRiskBucket,
  xiaohongshuNoteRiskSignals,
};
