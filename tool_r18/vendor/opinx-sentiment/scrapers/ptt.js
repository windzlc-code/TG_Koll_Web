/* global AbortSignal, console */

/**
 * scrapers/ptt.js — PTT 公開內容爬蟲
 *
 * 使用 PTT 非官方 API（公開可訪問）
 * 搜尋關鍵詞命中的文章，存入 crm_sentiment
 */

import { isRecentDate, isTaiwanRelatedText } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const DEFAULT_PTT_BOARDS = ["PublicServan", "give", "Gossiping"];
const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ARTICLE_COMMENTS = 30;
const DEFAULT_MAX_ARTICLES_PER_BOARD = 10;

/**
 * 爬取 PTT 搜尋結果
 * @param {string[]} keywords
 * @returns {number} 新增條目數
 */
export async function scrapePTT(keywords, { proxyUrl = "", budget = {}, boards = [] } = {}) {
  if (!keywords.length) return scraperResult(0);
  const jobs = [];
  const maxArticlesPerBoard = budgetItemsPerBoard(budget);
  const targetBoards = pttSearchBoards(boards);

  for (const keyword of keywords) {
    for (const board of targetBoards) jobs.push(fetchPTTBoard(keyword, board, { proxyUrl, maxArticlesPerBoard }));
  }

  const settled = await Promise.allSettled(jobs);
  let inserted = 0;
  const failures = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      failures.push({ message: formatSourceError(result.reason, proxyUrl) });
      continue;
    }
    const { keyword, articles } = result.value;
    if (result.value.error) {
      failures.push({ keyword, target: result.value.board, message: result.value.error });
    }
    for (const article of articles) {
      const enriched = await fetchPTTArticleDetails(article, { proxyUrl });
      if (enriched.error) failures.push({ keyword, target: result.value.board, message: enriched.error });
      const item = { ...article, ...enriched };
      if (!isRecentDate(item.publishedAt) || !isTaiwanRelatedText(item.title, item.content, item.url, item.author)) continue;
      const sentiment = analyzeSentiment(item.title + " " + item.content);
      const riskLevel = assessRiskLevel({ title: item.title, content: item.content, sentiment });
      const metrics = {
        board: item.board || "",
        search_scope: item.board ? "board" : "default-board",
        search_board: item.board || "",
        comment_count: item.comments.length,
        ptt_search_raw_result_count: Number(item.searchRawResultCount || 0),
        ptt_article_raw_comment_count: Number(item.rawCommentCount || item.comments.length || 0),
        ...pttKeywordDiagnostics(item, keyword),
        ...pttThreadRiskSignals(item, keyword),
      };
      const insertResult = insertSentimentItem({
        platform: "ptt",
        url: item.url,
        title: item.title,
        content: item.content.slice(0, 1200),
        author: item.author,
        sentiment,
        risk_level: riskLevel,
        keyword,
        keywords: [keyword],
        published_at: item.publishedAt,
        comments: item.comments,
        raw_html: item.rawHtml,
        source_metrics: metrics,
        evidence: {
          source_key: "ptt",
          evidence_type: "ptt_article",
          metrics,
        },
        source_type: "scraper",
      });
      if (insertResult.inserted) inserted++;
    }
  }

  return scraperResult(inserted, failures);
}

async function fetchPTTBoard(keyword, board, { proxyUrl = "", maxArticlesPerBoard = DEFAULT_MAX_ARTICLES_PER_BOARD } = {}) {
  try {
    const url = `https://www.ptt.cc/bbs/${board}/search?q=${encodeURIComponent(keyword)}`;
    const res = await fetchPublicSource(url, {
      headers: { "User-Agent": USER_AGENT, "Cookie": "over18=1" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return { keyword, board, articles: [], error: httpFailure(res) };

    const html = await res.text();
    const rawResultCount = countPTTSearchRawResults(html);
    return {
      keyword,
      board,
      articles: parsePTTSearchResults(html, { maxItems: maxArticlesPerBoard }).map(article => ({
        ...article,
        board,
        searchRawResultCount: rawResultCount,
      })),
    };
  } catch (err) {
    const message = formatSourceError(err, proxyUrl);
    console.warn(`[CRM/PTT] 爬取失敗 board=${board} keyword=${keyword}: ${message}`);
    return { keyword, board, articles: [], error: message };
  }
}

async function fetchPTTArticleDetails(article, { proxyUrl = "" } = {}) {
  try {
    const res = await fetchPublicSource(article.url, {
      headers: { "User-Agent": USER_AGENT, "Cookie": "over18=1" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return { content: article.content || "", comments: [], rawHtml: "", error: httpFailure(res) };
    const html = await res.text();
    return { ...parsePTTArticlePage(html), rawHtml: html };
  } catch (err) {
    return {
      content: article.content || "",
      comments: [],
      rawHtml: "",
      error: formatSourceError(err, proxyUrl),
    };
  }
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePttKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function pttKeywordNeedles(keyword = "") {
  const raw = stripTags(keyword).slice(0, 160);
  const compact = normalizePttKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function pttValueMatchesKeyword(value = "", keyword = "") {
  const lower = stripTags(value).slice(0, 1600).toLowerCase();
  const compact = normalizePttKeywordText(value);
  return pttKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizePttKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function pttKeywordMatchSource(item = {}, keyword = "") {
  if (!pttKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["board", item.board],
    ["url", item.url],
  ];
  const match = fields.find(([, value]) => pttValueMatchesKeyword(value, keyword));
  return match?.[0] || "search_result";
}

function pttKeywordDiagnostics(item = {}, keyword = "") {
  return {
    ptt_matched_keyword: stripTags(keyword).slice(0, 160),
    ptt_keyword_match_source: pttKeywordMatchSource(item, keyword),
  };
}

function pttTermMatches(text = "", terms = []) {
  const source = normalizePttKeywordText(text);
  return terms.filter(term => {
    const needle = normalizePttKeywordText(term);
    return needle && source.includes(needle);
  });
}

function pttCommentStats(comments = []) {
  const stats = { push: 0, boo: 0, neutral: 0 };
  for (const comment of Array.isArray(comments) ? comments : []) {
    const content = stripTags(comment?.content || "");
    if (/^推\b|^推\s|^推[:：]?/.test(content)) stats.push += 1;
    else if (/^噓\b|^噓\s|^噓[:：]?/.test(content)) stats.boo += 1;
    else if (/^→\b|^→\s|^→[:：]?/.test(content)) stats.neutral += 1;
  }
  return stats;
}

function pttThreadRiskSignals(item = {}, keyword = "") {
  const comments = Array.isArray(item.comments) ? item.comments : [];
  const commentText = comments.map(comment => comment?.content || "").join(" ");
  const text = `${item.title || ""} ${item.content || ""} ${commentText} ${keyword || ""}`;
  const evidenceTerms = pttTermMatches(text, [
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "憑證", "凭证", "聊天紀錄", "聊天记录",
    "對話紀錄", "对话记录", "匯款", "汇款", "發票", "发票", "訂單", "订单", "時間線", "时间线",
    "懶人包", "懒人包", "整理", "爆料", "實測", "实测", "證明", "证明", "receipt", "screenshot",
    "screen recording", "proof", "timeline",
  ]);
  const responseTerms = pttTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回應", "客服回应",
    "客服說明", "客服说明", "道歉", "致歉", "澄清", "後續", "后续", "說明", "说明", "official response",
    "official statement", "apology", "clarification", "customer support response",
  ]);
  const followupTerms = pttTermMatches(text, [
    "追蹤", "追踪", "更新", "後續", "后续", "續集", "续集", "轉傳", "转传", "懶人包", "懒人包",
    "整理", "延燒", "延烧", "發酵", "发酵", "爆卦", "爆料", "follow-up", "update", "repost",
  ]);
  const crisisTerms = pttTermMatches(text, [
    "詐騙", "诈骗", "投訴", "投诉", "客訴", "客诉", "退款", "拒退", "炎上", "翻車", "翻车",
    "爆雷", "危機", "危机", "抵制", "boycott", "complaint", "refund", "scam", "crisis",
  ]);
  const impactTerms = pttTermMatches(text, [
    "退款", "拒退", "客服", "款項", "款项", "金流", "受害", "損失", "损失", "風險", "风险",
    "詐騙", "诈骗", "炎上", "翻車", "翻车", "抵制", "危機", "危机", "refund", "customer support",
    "payment", "loss", "risk", "scam", "boycott", "crisis",
  ]);
  const stats = pttCommentStats(comments);
  const rawCommentCount = Number(item.rawCommentCount || comments.length || 0);
  const hasBoard = Boolean(item.board);
  const reasons = [];
  if (hasBoard) reasons.push("ptt-board-targeted");
  if (stats.push >= 3) reasons.push("ptt-push-amplification");
  if (stats.boo >= 1) reasons.push("ptt-boo-backlash");
  if (rawCommentCount >= 10) reasons.push("ptt-comment-volume");
  if (evidenceTerms.length) reasons.push("ptt-evidence-language");
  if (responseTerms.length) reasons.push("ptt-response-language");
  if (followupTerms.length) reasons.push("ptt-followup-language");
  if (crisisTerms.length) reasons.push("ptt-crisis-language");
  if (impactTerms.length) reasons.push("ptt-impact-language");
  const semanticSignals = [
    hasBoard,
    stats.push >= 3,
    stats.boo >= 1,
    rawCommentCount >= 10,
    evidenceTerms.length,
    responseTerms.length,
    followupTerms.length,
    crisisTerms.length,
    impactTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = hasBoard
    && evidenceTerms.length > 0
    && crisisTerms.length > 0
    && impactTerms.length > 0
    && (responseTerms.length > 0 || followupTerms.length > 0)
    && (stats.push >= 3 || stats.boo >= 1 || rawCommentCount >= 10)
    && semanticSignals >= 6;
  const score = Math.min(100,
    (hasBoard ? 8 : 0)
    + Math.min(18, stats.push * 3)
    + Math.min(16, stats.boo * 8)
    + Math.min(18, rawCommentCount * 2)
    + (evidenceTerms.length ? 18 : 0)
    + (responseTerms.length ? 10 : 0)
    + (followupTerms.length ? 10 : 0)
    + (crisisTerms.length ? 18 : 0)
    + (impactTerms.length ? 10 : 0)
    + (completeNarrative ? 12 : 0));
  return {
    ptt_thread_spread_score: score,
    ptt_thread_risk_bucket: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    ptt_thread_risk_reasons: [...new Set(reasons)],
    ptt_thread_semantic_signal_count: semanticSignals,
    ptt_thread_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    ptt_push_count: stats.push,
    ptt_boo_count: stats.boo,
    ptt_neutral_comment_count: stats.neutral,
    ptt_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    ptt_response_language_signal: responseTerms.length ? 1 : 0,
    ptt_followup_language_signal: followupTerms.length ? 1 : 0,
    ptt_crisis_language_signal: crisisTerms.length ? 1 : 0,
    ptt_impact_language_signal: impactTerms.length ? 1 : 0,
    ptt_evidence_terms: evidenceTerms,
    ptt_response_terms: responseTerms,
    ptt_followup_terms: followupTerms,
    ptt_impact_terms: impactTerms,
  };
}

function parsePTTArticlePage(html) {
  const main = String(html || "").match(/<div id="main-content"[^>]*>([\s\S]*?)<\/div>\s*<\/body>/i)?.[1] || "";
  const withoutMeta = main
    .replace(/<div class="article-metaline[\s\S]*?<\/div>/gi, " ")
    .replace(/<div class="article-metaline-right[\s\S]*?<\/div>/gi, " ");
  const beforePush = withoutMeta.split(/<div class="push"/i)[0] || "";
  const content = stripTags(beforePush)
    .replace(/※ 發信站:[\s\S]*$/i, "")
    .replace(/--\s*$/g, "")
    .trim();
  const comments = [];
  let rawCommentCount = 0;
  const pushRegex = /<div class="push">([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match;
  while ((match = pushRegex.exec(main)) !== null) {
    rawCommentCount += 1;
    const block = match[1];
    const tag = stripTags(block.match(/<span class="push-tag">([\s\S]*?)<\/span>/i)?.[1] || "");
    const author = stripTags(block.match(/<span class="push-userid">([\s\S]*?)<\/span>/i)?.[1] || "");
    const text = stripTags(block.match(/<span class="push-content">([\s\S]*?)<\/span>/i)?.[1] || "").replace(/^:\s*/, "");
    const ipdatetime = stripTags(block.match(/<span class="push-ipdatetime">([\s\S]*?)<\/span>/i)?.[1] || "");
    if (!text) continue;
    comments.push({
      external_id: `${author}:${comments.length}`,
      author,
      content: `${tag ? `${tag} ` : ""}${text}`.trim(),
      published_at: ipdatetime,
    });
    if (comments.length >= MAX_ARTICLE_COMMENTS) break;
  }
  return { content, comments, rawCommentCount };
}

function budgetItemsPerBoard(budget = {}) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ARTICLES_PER_BOARD));
  return Math.max(1, Math.min(50, Number.isFinite(value) ? value : DEFAULT_MAX_ARTICLES_PER_BOARD));
}

function normalizePttBoards(boards = []) {
  const raw = Array.isArray(boards)
    ? boards
    : typeof boards === "string"
      ? boards.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const value = stripTags(item)
      .replace(/^https?:\/\/(?:www\.)?ptt\.cc\/bbs\//i, "")
      .replace(/^\/?bbs\//i, "")
      .replace(/\/.*$/g, "")
      .replace(/[^\w-]/g, "")
      .slice(0, 40);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
    if (out.length >= 50) break;
  }
  return out;
}

function pttSearchBoards(boards = []) {
  const out = [...DEFAULT_PTT_BOARDS];
  const seen = new Set(out.map(board => board.toLowerCase()));
  for (const board of normalizePttBoards(boards)) {
    const key = board.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(board);
    }
  }
  return out.slice(0, 60);
}

function parsePTTSearchResults(html, { maxItems = DEFAULT_MAX_ARTICLES_PER_BOARD } = {}) {
  const articles = [];
  // 匹配搜尋結果列表項
  const itemRegex = /<div class="r-ent">([\s\S]*?)(?=<div class="r-ent">|$)/g;
  const titleRegex = /<a href="(\/bbs\/[^"]+)"[^>]*>([^<]+)<\/a>/;
  const authorRegex = /class="author">([^<]+)<\/div>/;
  const dateRegex = /class="date">\s*([^<]+)\s*<\/div>/;

  let match;
  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = titleRegex.exec(block);
    const authorMatch = authorRegex.exec(block);
    const dateMatch = dateRegex.exec(block);
    if (!titleMatch) continue;
    const publishedAt = parsePTTDate(dateMatch?.[1]);
    if (!publishedAt) continue;

    articles.push({
      url: `https://www.ptt.cc${titleMatch[1]}`,
      title: titleMatch[2].trim(),
      content: "",
      author: authorMatch ? authorMatch[1].trim() : "",
      publishedAt,
    });
  }
  return articles.slice(0, maxItems);
}

function countPTTSearchRawResults(html = "") {
  const source = String(html || "");
  let count = 0;
  const itemRegex = /<div class="r-ent">([\s\S]*?)(?=<div class="r-ent">|$)/g;
  let match;
  while ((match = itemRegex.exec(source)) !== null) {
    if (/<a href="\/bbs\/[^"]+"[^>]*>[^<]+<\/a>/i.test(match[1])) count += 1;
  }
  return count;
}

function parsePTTDate(rawDate, now = new Date()) {
  const match = /(\d{1,2})\/(\d{1,2})/.exec(String(rawDate || ""));
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;

  let date = new Date(now.getFullYear(), month - 1, day, 12, 0, 0);
  if (date.getTime() - now.getTime() > 7 * 24 * 60 * 60 * 1000) {
    date = new Date(now.getFullYear() - 1, month - 1, day, 12, 0, 0);
  }
  return date.toISOString();
}

export const __test__ = {
  DEFAULT_PTT_BOARDS,
  countPTTSearchRawResults,
  parsePTTSearchResults,
  parsePTTArticlePage,
  budgetItemsPerBoard,
  normalizePttBoards,
  pttSearchBoards,
  normalizePttKeywordText,
  pttValueMatchesKeyword,
  pttKeywordMatchSource,
  pttKeywordDiagnostics,
  pttThreadRiskSignals,
};
