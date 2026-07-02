/**
 * scrapers/investor-discussion-sources.js — public investor and market narrative discovery
 *
 * Uses no-key public endpoints to collect market-facing discussion signals:
 * Stocktwits public symbol streams and Yahoo Finance public search metadata.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const DEFAULT_MAX_SYMBOLS_PER_KEYWORD = 4;
const MARKET_CONTEXT_TERMS = [
  "stock", "shares", "investor", "market", "earnings", "short", "bearish", "bullish", "selloff", "downgrade",
  "lawsuit", "investigation", "refund", "complaint", "boycott", "scam", "fraud", "data breach", "outage",
  "股價", "股票", "投資者", "投资者", "投資人", "投资人", "財報", "财报", "做空", "空頭", "空头",
  "暴跌", "下跌", "危機", "危机", "訴訟", "诉讼", "調查", "调查", "詐騙", "诈骗", "抵制", "退款",
];

function cleanText(value = "", max = 1000) {
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
  const maxSymbols = Math.round(Number(budget.maxSymbolsPerKeyword || budget.max_symbols_per_keyword || DEFAULT_MAX_SYMBOLS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.max(1, Math.min(5, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
    maxSymbolsPerKeyword: Number.isFinite(maxSymbols) ? Math.max(1, Math.min(8, maxSymbols)) : DEFAULT_MAX_SYMBOLS_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeInvestorDiscussionKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeInvestorDiscussionKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function symbolCandidatesForKeyword(keyword = "") {
  const text = cleanText(keyword, 160);
  const out = [];
  for (const match of text.matchAll(/\$?([A-Z]{1,5})(?:[.\-][A-Z]{1,3})?\b/g)) {
    const symbol = match[1];
    if (symbol && !out.includes(symbol)) out.push(symbol);
  }
  return out.slice(0, DEFAULT_MAX_SYMBOLS_PER_KEYWORD);
}

function stocktwitsSymbolUrl(symbol = "", { max = "" } = {}) {
  const params = new URLSearchParams();
  if (max) params.set("max", cleanText(max, 80));
  const query = params.toString();
  return `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(String(symbol || "").toUpperCase())}.json${query ? `?${query}` : ""}`;
}

function yahooFinanceSearchUrl(keyword = "") {
  const params = new URLSearchParams({
    q: cleanText(keyword, 120),
    quotesCount: "8",
    newsCount: "0",
  });
  return `https://query2.finance.yahoo.com/v1/finance/search?${params.toString()}`;
}

function messageUrl(message = {}) {
  const id = cleanText(message.id || message.message_id || "", 80);
  const username = cleanText(message.user?.username || message.user?.name || "stocktwits", 80);
  return id ? `https://stocktwits.com/${encodeURIComponent(username)}/message/${encodeURIComponent(id)}` : "";
}

function normalizeInvestorDiscussionDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    for (const param of ["url", "u", "target"]) {
      const embedded = url.searchParams.get(param);
      if (embedded && /^https?:\/\//i.test(embedded)) return normalizeInvestorDiscussionDedupeUrl(embedded);
    }
    url.hash = "";
    for (const param of [
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
    ]) {
      url.searchParams.delete(param);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function investorDiscussionDedupeKey(item = {}) {
  const urlKey = normalizeInvestorDiscussionDedupeUrl(item.url || "");
  if (urlKey) return urlKey;
  return [
    "investor-discussion",
    cleanText(item.metrics?.source || "", 80),
    cleanText(item.metrics?.message_id || "", 80),
    cleanText(item.publishedAt || "", 80),
    cleanText(item.content || "", 360),
  ].map(part => String(part || "").toLowerCase()).join("|");
}

function textMatchesKeyword(text = "", keyword = "", symbols = []) {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeInvestorDiscussionKeywordText(text);
  const needles = keywordNeedles(keyword);
  if (needles.some((needle) => {
    const normalizedNeedle = normalizeInvestorDiscussionKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  })) return true;
  return symbols.some(symbol => {
    const upper = String(symbol || "").toUpperCase();
    return upper && (lower.includes(`$${upper.toLowerCase()}`) || new RegExp(`\\b${upper}\\b`, "i").test(text));
  });
}

function investorDiscussionKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const symbols = [
    metrics.symbol,
    metrics.cashtag,
    ...(Array.isArray(metrics.mentioned_symbols) ? metrics.mentioned_symbols : []),
  ].filter(Boolean);
  const fields = [
    ["content", item.content],
    ["symbol", metrics.symbol],
    ["cashtag", metrics.cashtag],
    ["mentioned_symbols", symbols.join(" ")],
    ["author", item.author],
    ["user", metrics.user],
    ["sentiment_hint", metrics.sentiment_hint],
    ["url", item.url],
    ["title", item.title],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword(value || "", keyword, symbols));
  return match ? match[0] : "";
}

function investorDiscussionKeywordDiagnostics(item = {}, keyword = "") {
  return {
    investor_discussion_matched_keyword: cleanText(keyword, 160),
    investor_discussion_keyword_match_source: investorDiscussionKeywordMatchSource(item, keyword),
  };
}

function hasMarketContext(text = "", sentimentHint = "") {
  const lower = String(`${text} ${sentimentHint}`).toLowerCase();
  return MARKET_CONTEXT_TERMS.some(term => lower.includes(term.toLowerCase()));
}

function investorNarrativeRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 40) return "medium";
  return "low";
}

function investorNarrativeSignals({ content = "", sentimentHint = "", symbols = [] } = {}) {
  const text = cleanText(`${content} ${sentimentHint} ${(Array.isArray(symbols) ? symbols : []).join(" ")}`, 2200).toLowerCase();
  const termMatches = (terms = []) => terms.filter(term => {
    const needle = cleanText(term, 120).toLowerCase();
    return needle && text.includes(needle);
  });
  const bearish = /bearish|short|puts?|selloff|sell-off|dump|downgrade|collapse|crash|downside|做空|空頭|空头|看空|暴跌|崩盤|崩盘|下跌|拋售|抛售/.test(text);
  const bullish = /bullish|long|calls?|buy|accumulate|upgrade|breakout|upside|看多|做多|買入|买入|反彈|反弹|上漲|上涨/.test(text);
  const lawsuit = /lawsuit|class action|legal action|sue|litigation|訴訟|诉讼|集體訴訟|集体诉讼|起訴|起诉/.test(text);
  const investigation = /investigation|probe|regulator|sec|doj|ftc|antitrust|調查|调查|監管|监管|執法|执法|反壟斷|反垄断/.test(text);
  const fraud = /fraud|scam|fake|misleading|accounting issue|restatement|詐騙|诈骗|造假|欺詐|欺诈|誤導|误导|財務造假|财务造假/.test(text);
  const earnings = /earnings|guidance|revenue|margin|profit|eps|miss|財報|财报|營收|营收|利潤|利润|指引|業績|业绩/.test(text);
  const customerTrust = /refund|complaint|boycott|churn|trust|reputation|customer|support|退款|投訴|投诉|抵制|流失|信任|聲譽|声誉|客服/.test(text);
  const security = /breach|data leak|security|vulnerability|ransomware|outage|安全|漏洞|外洩|泄露|勒索|故障|宕机|宕機/.test(text);
  const volatility = /volatile|volatility|halt|gap down|pre[- ]?market|after[- ]?hours|波動|波动|停牌|跳空|盤前|盘前|盤後|盘后/.test(text);
  const evidenceTerms = termMatches([
    "sec filing", "8-k", "10-q", "10-k", "press release", "screenshot", "receipt", "lawsuit filing", "docket", "source", "link",
    "公告", "財報", "财报", "截圖", "截图", "收據", "收据", "起訴書", "起诉书", "案號", "案号", "來源", "来源", "連結", "链接",
  ]);
  const spreadTerms = termMatches([
    "trending", "viral", "message volume", "watchlist", "reddit", "wallstreetbets", "stocktwits", "twitter", "x post", "social media", "news",
    "熱議", "热议", "趨勢", "趋势", "爆量", "關注列表", "关注列表", "社群", "社媒", "新聞", "新闻", "轉發", "转发",
  ]);
  const marketImpactTerms = termMatches([
    "stock drop", "share price", "market cap", "pre-market", "after-hours", "gap down", "halt", "short interest", "volume spike", "downgrade",
    "股價", "股价", "市值", "盤前", "盘前", "盤後", "盘后", "跳空", "停牌", "做空比例", "成交量", "降評", "降评",
  ]);
  const responseTerms = termMatches([
    "company response", "management response", "ceo response", "official statement", "denied", "apology", "remediation", "guidance update", "buyback",
    "公司回應", "公司回应", "管理層回應", "管理层回应", "ceo回應", "ceo回应", "官方聲明", "官方声明", "否認", "否认", "道歉", "整改", "指引更新", "回購", "回购",
  ]);
  const evidenceSignal = evidenceTerms.length > 0;
  const spreadSignal = spreadTerms.length > 0;
  const marketImpactSignal = marketImpactTerms.length > 0 || volatility;
  const responseSignal = responseTerms.length > 0;
  const reasons = [];
  if (bearish) reasons.push("bearish-short-selloff-language");
  if (bullish) reasons.push("bullish-counter-narrative");
  if (lawsuit) reasons.push("lawsuit-litigation-language");
  if (investigation) reasons.push("regulatory-investigation-language");
  if (fraud) reasons.push("fraud-misconduct-language");
  if (earnings) reasons.push("earnings-guidance-language");
  if (customerTrust) reasons.push("customer-trust-risk-language");
  if (security) reasons.push("security-operational-risk-language");
  if (volatility) reasons.push("market-volatility-language");
  if (evidenceSignal) reasons.push("investor-evidence-language");
  if (spreadSignal) reasons.push("investor-spread-language");
  if (marketImpactSignal) reasons.push("investor-market-impact-language");
  if (responseSignal) reasons.push("investor-company-response-language");
  const semanticSignals = [
    bearish,
    bullish,
    lawsuit,
    investigation,
    fraud,
    earnings,
    customerTrust,
    security,
    volatility,
    evidenceSignal,
    spreadSignal,
    marketImpactSignal,
    responseSignal,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 6
    && (bearish || fraud || lawsuit || investigation || customerTrust || security || earnings)
    && marketImpactSignal
    && (spreadSignal || evidenceSignal)
    && (responseSignal || lawsuit || investigation || fraud);
  const riskScore = Math.min(100,
    (bearish ? 22 : 0)
    + (lawsuit ? 18 : 0)
    + (investigation ? 18 : 0)
    + (fraud ? 22 : 0)
    + (earnings ? 12 : 0)
    + (customerTrust ? 14 : 0)
    + (security ? 16 : 0)
    + (volatility ? 10 : 0)
    + (evidenceSignal ? 8 : 0)
    + (spreadSignal ? 8 : 0)
    + (marketImpactSignal ? 8 : 0)
    + (responseSignal ? 6 : 0)
    + (completeNarrative ? 8 : 0)
    - (bullish && !bearish ? 8 : 0)
  );
  return {
    investor_bearish_signal: bearish ? 1 : 0,
    investor_bullish_signal: bullish ? 1 : 0,
    investor_lawsuit_signal: lawsuit ? 1 : 0,
    investor_investigation_signal: investigation ? 1 : 0,
    investor_fraud_signal: fraud ? 1 : 0,
    investor_earnings_risk_signal: earnings ? 1 : 0,
    investor_customer_trust_signal: customerTrust ? 1 : 0,
    investor_security_operational_signal: security ? 1 : 0,
    investor_volatility_signal: volatility ? 1 : 0,
    investor_evidence_language_signal: evidenceSignal ? 1 : 0,
    investor_spread_language_signal: spreadSignal ? 1 : 0,
    investor_market_impact_signal: marketImpactSignal ? 1 : 0,
    investor_company_response_signal: responseSignal ? 1 : 0,
    investor_complete_market_crisis_narrative_signal: completeNarrative ? 1 : 0,
    investor_semantic_signal_count: semanticSignals,
    investor_evidence_terms: evidenceTerms,
    investor_spread_terms: spreadTerms,
    investor_market_impact_terms: marketImpactTerms,
    investor_response_terms: responseTerms,
    investor_market_narrative_risk_score: Math.max(0, riskScore),
    investor_market_narrative_risk_bucket: investorNarrativeRiskBucket(riskScore),
    investor_signal_count: reasons.length,
    investor_signal_reasons: reasons,
  };
}

function symbolListFromMessage(message = {}) {
  const entitySymbols = Array.isArray(message.entities?.symbols) ? message.entities.symbols : [];
  const symbols = entitySymbols.map(item => cleanText(item.symbol || item.symbol_id || "", 20).toUpperCase()).filter(Boolean);
  for (const match of String(message.body || "").matchAll(/\$([A-Z]{1,5})(?:[.\-][A-Z]{1,3})?\b/g)) {
    if (match[1] && !symbols.includes(match[1])) symbols.push(match[1]);
  }
  return symbols.slice(0, 12);
}

function stocktwitsNextMaxCursor(messages = []) {
  const ids = (Array.isArray(messages) ? messages : [])
    .map(message => Number(message?.id || message?.message_id || 0))
    .filter(id => Number.isFinite(id) && id > 1);
  if (!ids.length) return "";
  return String(Math.min(...ids) - 1);
}

export function parseStocktwitsMessages(payload, keyword = "", { symbol = "", limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "", page = 1, rawResultCount = 0 } = {}) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const normalizedRawResultCount = Number(rawResultCount) > 0 ? Number(rawResultCount) : messages.length;
  const out = [];
  const seen = new Set();
  for (const message of messages) {
    const body = cleanText(message.body || message.text || "", 900);
    if (!body) continue;
    const publishedAt = normalizeDate(message.created_at || message.createdAt || message.date) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const mentionedSymbols = symbolListFromMessage(message);
    const expectedSymbols = [symbol, ...mentionedSymbols].filter(Boolean);
    const sentimentHint = cleanText(message.entities?.sentiment?.basic || message.sentiment?.basic || "", 40);
    if (!textMatchesKeyword(body, keyword, expectedSymbols)) continue;
    if (!hasMarketContext(body, sentimentHint) && !sentimentHint) continue;
    const url = messageUrl(message);
    const dedupeKey = url || `${publishedAt}:${body}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const author = cleanText(message.user?.username || message.user?.name || "Stocktwits user", 120);
    const title = `Stocktwits investor discussion: ${keyword}`;
    const narrativeSignals = investorNarrativeSignals({
      content: body,
      sentimentHint,
      symbols: expectedSymbols,
    });
    out.push({
      url: url || `https://stocktwits.com/symbol/${encodeURIComponent(String(symbol || mentionedSymbols[0] || "").toUpperCase())}`,
      title,
      content: body,
      author,
      publishedAt,
      metrics: {
        source: "stocktwits_public_symbol_stream",
        source_family: "finance",
        source_kind: "public_investor_discussion",
        collection_mode: "stocktwits_public_json",
        investor_discussion_search_page: Math.max(1, Number(page) || 1),
        investor_discussion_raw_result_count: Math.max(0, normalizedRawResultCount),
        symbol: cleanText(symbol || mentionedSymbols[0] || "", 20).toUpperCase(),
        cashtag: cleanText(symbol || mentionedSymbols[0] || "", 20).toUpperCase() ? `$${cleanText(symbol || mentionedSymbols[0] || "", 20).toUpperCase()}` : "",
        message_id: cleanText(message.id || "", 80),
        user: author,
        created_at: publishedAt,
        sentiment_hint: sentimentHint,
        mentioned_symbols: mentionedSymbols,
        source_weight_tier: "public-investor-discussion",
        ...narrativeSignals,
      },
    });
    if (out.length >= Math.max(1, Math.min(30, Number(limit) || DEFAULT_MAX_ITEMS_PER_KEYWORD))) break;
  }
  return out;
}

export function parseYahooFinanceSearch(payload, keyword = "", { limit = DEFAULT_MAX_SYMBOLS_PER_KEYWORD } = {}) {
  const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
  const needles = keywordNeedles(keyword);
  const out = [];
  for (const quote of quotes) {
    const symbol = cleanText(quote.symbol || "", 20).toUpperCase();
    if (!/^[A-Z0-9.=-]{1,8}$/.test(symbol)) continue;
    const text = cleanText([
      quote.shortname,
      quote.longname,
      quote.name,
      quote.exchange,
      quote.quoteType,
    ].filter(Boolean).join(" "), 500).toLowerCase();
    if (needles.length && !textMatchesKeyword(text, keyword)) continue;
    out.push({
      symbol,
      name: cleanText(quote.shortname || quote.longname || quote.name || symbol, 160),
      exchange: cleanText(quote.exchange || quote.exchDisp || "", 80),
      quoteType: cleanText(quote.quoteType || quote.typeDisp || "", 80),
    });
    if (out.length >= Math.max(1, Math.min(8, Number(limit) || DEFAULT_MAX_SYMBOLS_PER_KEYWORD))) break;
  }
  return out;
}

async function insertInvestorItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = investorDiscussionDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = assessRiskLevel({ title: item.title, content: item.content, sentiment });
    const result = insertSentimentItem({
      platform: "investor_discussion_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment,
      risk_level: risk,
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "investorDiscussionSources",
      evidence: {
        evidence_type: "investor_discussion_signal",
        metrics: {
          ...(item.metrics || {}),
          ...investorDiscussionKeywordDiagnostics(item, keyword),
          investor_discussion_canonical_dedupe_url: dedupeKey,
          investor_discussion_search_scan_dedupe_key: dedupeKey,
          ...(attribution.length ? {
            failover_attribution: attribution,
            failover_from_sources: failoverFromSources,
          } : {}),
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

export async function scrapeInvestorDiscussionSources(keywords, { proxyUrl = "", budget = {}, since = "", domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    try {
      const symbols = symbolCandidatesForKeyword(keyword);
      if (symbols.length < normalizedBudget.maxSymbolsPerKeyword) {
        const res = await fetchPublicSource(yahooFinanceSearchUrl(keyword), {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (res.ok) {
          for (const candidate of parseYahooFinanceSearch(await res.json(), keyword, { limit: normalizedBudget.maxSymbolsPerKeyword })) {
            if (!symbols.includes(candidate.symbol)) symbols.push(candidate.symbol);
            if (symbols.length >= normalizedBudget.maxSymbolsPerKeyword) break;
          }
        } else {
          failures.push({ keyword, target: "yahoo-finance-search", message: httpFailure(res) });
        }
      }
      for (const symbol of symbols.slice(0, normalizedBudget.maxSymbolsPerKeyword)) {
        if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        let maxCursor = "";
        const seenCursors = new Set();
        for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
          const res = await fetchPublicSource(stocktwitsSymbolUrl(symbol, { max: maxCursor }), {
            headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }, proxyUrl);
          if (!res.ok) {
            failures.push({ keyword, target: `stocktwits:${symbol}:page:${page}`, message: httpFailure(res) });
            break;
          }
          const payload = await res.json();
          const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
          const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
          const items = parseStocktwitsMessages(payload, keyword, {
            symbol,
            limit: remaining,
            since,
            page,
            rawResultCount: rawMessages.length,
          });
          inserted += await insertInvestorItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
          const nextCursor = stocktwitsNextMaxCursor(rawMessages);
          if (!nextCursor || seenCursors.has(nextCursor) || !rawMessages.length) break;
          seenCursors.add(nextCursor);
          maxCursor = nextCursor;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: "investor-discussion", message });
      console.warn(`[CRM/InvestorDiscussion] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  MARKET_CONTEXT_TERMS,
  normalizeBudget,
  normalizeInvestorDiscussionKeywordText,
  textMatchesKeyword,
  symbolCandidatesForKeyword,
  stocktwitsSymbolUrl,
  stocktwitsNextMaxCursor,
  yahooFinanceSearchUrl,
  normalizeInvestorDiscussionDedupeUrl,
  investorDiscussionDedupeKey,
  investorDiscussionKeywordMatchSource,
  investorDiscussionKeywordDiagnostics,
  investorNarrativeRiskBucket,
  investorNarrativeSignals,
  parseStocktwitsMessages,
  parseYahooFinanceSearch,
};
