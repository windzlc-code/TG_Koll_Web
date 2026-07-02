/**
 * scrapers/dcard.js — Dcard 公開 API 爬蟲
 *
 * Dcard 有公開的 REST API，無需登入
 * https://www.dcard.tw/service/api/v2/posts
 */

import { isTaiwanRecentItem } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const DCARD_API = "https://www.dcard.tw/service/api/v2";
const REQUEST_TIMEOUT_MS = 15000;
const KEYWORD_CONCURRENCY = 2;
const MAX_COMMENTS = 30;
const DEFAULT_MAX_POSTS_PER_KEYWORD = 10;
const DEFAULT_DCARD_SEARCH_TARGETS = [{ forum: "", label: "dcard-global" }];

/**
 * 爬取 Dcard 搜尋結果
 * @param {string[]} keywords
 * @returns {number} 新增條目數
 */
export async function scrapeDcard(keywords, { proxyUrl = "", budget = {}, forums = [], forum = [] } = {}) {
  if (!keywords.length) return scraperResult(0);
  const maxPosts = budgetItemsPerKeyword(budget);
  const targets = dcardSearchTargets(forums?.length ? forums : forum);

  const tasks = [];
  for (const keyword of keywords) {
    for (const target of targets) tasks.push({ keyword, target });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      const url = target.forum
        ? `${DCARD_API}/forums/${encodeURIComponent(target.forum)}/posts?popular=false&limit=${encodeURIComponent(maxPosts)}`
        : `${DCARD_API}/search/posts?query=${encodeURIComponent(keyword)}&limit=${encodeURIComponent(maxPosts)}`;
      const res = await fetchPublicSource(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "Origin": "https://www.dcard.tw",
          "Referer": target.forum
            ? `https://www.dcard.tw/f/${encodeURIComponent(target.forum)}`
            : `https://www.dcard.tw/search/posts?query=${encodeURIComponent(keyword)}`,
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }, proxyUrl);

      if (!res.ok) {
        const message = res.status === 403
          ? "HTTP 403 Forbidden（Dcard 目前封鎖此代理/IP 的公開搜尋請求）"
          : httpFailure(res);
        failures.push({ keyword, target: target.label, message });
        return { inserted, failures };
      }
      const posts = await res.json();
      if (!Array.isArray(posts)) return { inserted, failures };
      const rawPostCount = posts.length;

      for (const post of posts) {
        const postUrl = `https://www.dcard.tw/f/${post.forumAlias}/p/${post.id}`;
        const title = post.title || "";
        const details = await fetchDcardPostDetails(post, { proxyUrl });
        if (details.error) failures.push({ keyword, target: String(post.id || ""), message: details.error });
        const content = (details.content || post.excerpt || post.content || "").slice(0, 1200);
        const keywordText = `${title} ${content}`;
        if (target.forum && !dcardValueMatchesKeyword(keywordText, keyword)) continue;
        const publishedAt = post.createdAt || post.updatedAt || null;
        if (!isTaiwanRecentItem({
          title,
          content,
          url: postUrl,
          source: post.forumName || post.forumAlias || "",
          publishedAt,
        })) continue;

        const sentiment = analyzeSentiment(title + " " + content);
        const metrics = {
          forum_alias: post.forumAlias || target.forum || "",
          forum_name: post.forumName || "",
          search_scope: target.forum ? "forum" : "global",
          search_forum: target.forum || "",
          like_count: post.likeCount ?? post.like_count,
          comment_count: details.comments.length || post.commentCount || post.comment_count,
          dcard_search_raw_post_count: rawPostCount,
          dcard_detail_fetch_status: details.detailFetched ? "fetched" : "fallback",
          dcard_raw_comment_count: Number(details.rawCommentCount || 0),
          ...dcardKeywordDiagnostics({
            ...post,
            url: postUrl,
            title,
            content,
            author: post.school || post.gender || "",
            targetForum: target.forum || "",
          }, keyword),
          ...dcardPostRiskSignals({
            ...post,
            url: postUrl,
            title,
            content,
            comments: details.comments,
            rawCommentCount: details.rawCommentCount,
            detailFetched: details.detailFetched,
            targetForum: target.forum || "",
          }, keyword),
        };
        const result = insertSentimentItem({
          platform: "dcard",
          url: postUrl,
          title,
          content,
          author: post.school || post.gender || "",
          sentiment,
          risk_level: assessRiskLevel({ title, content, sentiment }),
          keyword,
          keywords: [keyword],
          published_at: publishedAt,
          comments: details.comments,
          raw_json: details.rawJson,
          source_metrics: metrics,
          evidence: {
            source_key: "dcard",
            evidence_type: "dcard_post",
            metrics,
          },
          source_type: "scraper",
        });
        if (result.inserted) inserted++;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.label, message });
      console.warn(`[CRM/Dcard] 爬取失敗 target=${target.label} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

function normalizeDcardForums(forums = []) {
  const raw = Array.isArray(forums)
    ? forums
    : typeof forums === "string"
      ? forums.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const value = String(item || "")
      .trim()
      .replace(/^https?:\/\/(?:www\.)?dcard\.tw\/f\//i, "")
      .replace(/^\/?f\//i, "")
      .replace(/\/.*$/g, "")
      .replace(/[^\w-]/g, "")
      .slice(0, 60);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
    if (out.length >= 50) break;
  }
  return out;
}

function dcardSearchTargets(forums = []) {
  return [
    ...DEFAULT_DCARD_SEARCH_TARGETS,
    ...normalizeDcardForums(forums).map(forum => ({
      forum,
      label: `dcard-forum-${forum}`,
    })),
  ];
}

function budgetItemsPerKeyword(budget = {}) {
  const value = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_POSTS_PER_KEYWORD));
  return Math.max(1, Math.min(50, Number.isFinite(value) ? value : DEFAULT_MAX_POSTS_PER_KEYWORD));
}

function normalizeDcardKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function dcardKeywordNeedles(keyword = "") {
  const raw = String(keyword || "").trim().slice(0, 160);
  const compact = normalizeDcardKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function dcardValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").trim().slice(0, 1600).toLowerCase();
  const compact = normalizeDcardKeywordText(value);
  return dcardKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeDcardKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function dcardKeywordMatchSource(item = {}, keyword = "") {
  if (!dcardKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author || item.school || item.gender],
    ["forum", item.forumAlias || item.forumName || item.targetForum],
    ["url", item.url],
  ];
  const match = fields.find(([, value]) => dcardValueMatchesKeyword(value, keyword));
  return match?.[0] || "search_result";
}

function dcardKeywordDiagnostics(item = {}, keyword = "") {
  return {
    dcard_matched_keyword: String(keyword || "").trim().slice(0, 160),
    dcard_keyword_match_source: dcardKeywordMatchSource(item, keyword),
  };
}

function dcardTermMatches(text = "", terms = []) {
  const source = normalizeDcardKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeDcardKeywordText(term);
    return needle && source.includes(needle);
  });
}

function dcardPostRiskSignals(item = {}, keyword = "") {
  const comments = Array.isArray(item.comments) ? item.comments : [];
  const commentText = comments.map(comment => comment?.content || "").join(" ");
  const text = `${item.title || ""} ${item.content || ""} ${commentText} ${keyword || ""}`;
  const likeCount = Number(item.likeCount ?? item.like_count ?? 0);
  const commentCount = Number(item.rawCommentCount || item.commentCount || item.comment_count || comments.length || 0);
  const hasPostId = Boolean(item.id);
  const hasForum = Boolean(item.forumAlias || item.targetForum);
  const detailFetched = item.detailFetched === true;
  const evidenceTerms = dcardTermMatches(text, [
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "憑證", "凭证", "聊天紀錄", "聊天记录",
    "對話紀錄", "对话记录", "匯款", "汇款", "發票", "发票", "訂單", "订单", "時間線", "时间线",
    "懶人包", "懒人包", "整理", "爆料", "實測", "实测", "證明", "证明", "receipt", "screenshot",
    "screen recording", "proof", "timeline",
  ]);
  const responseTerms = dcardTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回應", "客服回应",
    "客服說明", "客服说明", "道歉", "致歉", "澄清", "後續", "后续", "說明", "说明", "official response",
    "official statement", "apology", "clarification", "customer support response",
  ]);
  const followupTerms = dcardTermMatches(text, [
    "追蹤", "追踪", "更新", "後續", "后续", "續集", "续集", "轉傳", "转传", "懶人包", "懒人包",
    "整理", "延燒", "延烧", "發酵", "发酵", "爆料", "follow-up", "update", "repost",
  ]);
  const crisisTerms = dcardTermMatches(text, [
    "詐騙", "诈骗", "投訴", "投诉", "客訴", "客诉", "退款", "拒退", "炎上", "翻車", "翻车",
    "爆雷", "危機", "危机", "抵制", "boycott", "complaint", "refund", "scam", "crisis",
  ]);
  const impactTerms = dcardTermMatches(text, [
    "退款", "拒退", "客服", "款項", "款项", "金流", "受害", "損失", "损失", "風險", "风险",
    "詐騙", "诈骗", "炎上", "翻車", "翻车", "抵制", "危機", "危机", "refund", "customer support",
    "payment", "loss", "risk", "scam", "boycott", "crisis",
  ]);
  const reasons = [];
  if (hasPostId) reasons.push("dcard-post-id-present");
  if (hasForum) reasons.push("dcard-forum-targeted");
  if (detailFetched) reasons.push("dcard-detail-fetched");
  if (likeCount >= 10) reasons.push("dcard-like-amplification");
  if (commentCount >= 5) reasons.push("dcard-comment-volume");
  if (evidenceTerms.length) reasons.push("dcard-evidence-language");
  if (responseTerms.length) reasons.push("dcard-response-language");
  if (followupTerms.length) reasons.push("dcard-followup-language");
  if (crisisTerms.length) reasons.push("dcard-crisis-language");
  if (impactTerms.length) reasons.push("dcard-impact-language");
  const semanticSignals = [
    hasPostId,
    hasForum,
    detailFetched,
    likeCount >= 10,
    commentCount >= 5,
    evidenceTerms.length,
    responseTerms.length,
    followupTerms.length,
    crisisTerms.length,
    impactTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = hasPostId
    && hasForum
    && evidenceTerms.length > 0
    && crisisTerms.length > 0
    && impactTerms.length > 0
    && (responseTerms.length > 0 || followupTerms.length > 0)
    && (likeCount >= 10 || commentCount >= 5)
    && semanticSignals >= 7;
  const score = Math.min(100,
    (hasPostId ? 6 : 0)
    + (hasForum ? 8 : 0)
    + (detailFetched ? 8 : 0)
    + Math.min(16, likeCount)
    + Math.min(18, commentCount * 3)
    + (evidenceTerms.length ? 18 : 0)
    + (responseTerms.length ? 10 : 0)
    + (followupTerms.length ? 10 : 0)
    + (crisisTerms.length ? 18 : 0)
    + (impactTerms.length ? 10 : 0)
    + (completeNarrative ? 12 : 0));
  return {
    dcard_post_spread_score: score,
    dcard_post_risk_bucket: score >= 70 ? "high" : score >= 35 ? "medium" : "low",
    dcard_post_risk_reasons: [...new Set(reasons)],
    dcard_post_semantic_signal_count: semanticSignals,
    dcard_post_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    dcard_post_id_signal: hasPostId ? 1 : 0,
    dcard_forum_signal: hasForum ? 1 : 0,
    dcard_detail_signal: detailFetched ? 1 : 0,
    dcard_like_amplification_signal: likeCount >= 10 ? 1 : 0,
    dcard_comment_volume_signal: commentCount >= 5 ? 1 : 0,
    dcard_evidence_language_signal: evidenceTerms.length ? 1 : 0,
    dcard_response_language_signal: responseTerms.length ? 1 : 0,
    dcard_followup_language_signal: followupTerms.length ? 1 : 0,
    dcard_crisis_language_signal: crisisTerms.length ? 1 : 0,
    dcard_impact_language_signal: impactTerms.length ? 1 : 0,
    dcard_evidence_terms: evidenceTerms,
    dcard_response_terms: responseTerms,
    dcard_followup_terms: followupTerms,
    dcard_impact_terms: impactTerms,
  };
}

function dcardHeaders(keyword = "") {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://www.dcard.tw",
    "Referer": keyword
      ? `https://www.dcard.tw/search/posts?query=${encodeURIComponent(keyword)}`
      : "https://www.dcard.tw/",
    "X-Requested-With": "XMLHttpRequest",
  };
}

async function fetchDcardJson(url, { proxyUrl = "", keyword = "" } = {}) {
  const res = await fetchPublicSource(url, {
    headers: dcardHeaders(keyword),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl);
  if (!res.ok) throw new Error(res.status === 403
    ? "HTTP 403 Forbidden（Dcard 目前封鎖此代理/IP 的公開請求）"
    : httpFailure(res));
  return res.json();
}

async function fetchDcardPostDetails(post, { proxyUrl = "" } = {}) {
  const id = post?.id;
  if (!id) return { content: post?.excerpt || post?.content || "", comments: [], rawJson: post, error: "" };
  const out = {
    content: post.excerpt || post.content || "",
    comments: [],
    rawJson: { searchPost: post },
    error: "",
    detailFetched: false,
    rawCommentCount: 0,
  };
  try {
    const detail = await fetchDcardJson(`${DCARD_API}/posts/${id}`, { proxyUrl });
    out.content = detail.content || detail.excerpt || out.content;
    out.rawJson.detail = detail;
    out.detailFetched = true;
  } catch (err) {
    out.error = formatSourceError(err, proxyUrl);
  }
  try {
    const comments = await fetchDcardJson(`${DCARD_API}/posts/${id}/comments?limit=${MAX_COMMENTS}`, { proxyUrl });
    if (Array.isArray(comments)) {
      out.rawCommentCount = comments.length;
      out.comments = comments.slice(0, MAX_COMMENTS).map(comment => ({
        external_id: comment.id || "",
        author: comment.school || comment.gender || (comment.floor ? `B${comment.floor}` : ""),
        content: comment.content || "",
        published_at: comment.createdAt || comment.updatedAt || "",
        metrics: {
          like_count: comment.likeCount,
        },
      })).filter(comment => comment.content);
      out.rawJson.comments = comments;
    }
  } catch (err) {
    out.error = out.error || formatSourceError(err, proxyUrl);
  }
  return out;
}

export const __test__ = {
  fetchDcardPostDetails,
  budgetItemsPerKeyword,
  normalizeDcardForums,
  dcardSearchTargets,
  normalizeDcardKeywordText,
  dcardValueMatchesKeyword,
  dcardKeywordMatchSource,
  dcardKeywordDiagnostics,
  dcardPostRiskSignals,
};
