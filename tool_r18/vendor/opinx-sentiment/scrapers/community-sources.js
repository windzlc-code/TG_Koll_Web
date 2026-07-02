import { mapWithConcurrency } from "./concurrency.js";
import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const MAX_COMMUNITY_COMMENTS = 20;
const DEFAULT_REDDIT_SEARCH_TARGETS = [{ subreddit: "", label: "reddit-global" }];
const DEFAULT_GITHUB_ISSUE_TARGETS = [{ repository: "", label: "github-global" }];
const DEFAULT_HACKER_NEWS_SEARCH_TARGETS = [{ author: "", label: "hackernews-global" }];
const DEFAULT_STACK_OVERFLOW_SEARCH_TARGETS = [{ tag: "", label: "stackoverflow-global" }];

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.min(50, Math.max(1, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxPagesPerKeyword: Number.isFinite(maxPages) ? Math.min(5, Math.max(1, maxPages)) : DEFAULT_MAX_PAGES_PER_KEYWORD,
  };
}

function normalizeDeepBudget(deepBudget = null) {
  if (!deepBudget || typeof deepBudget !== "object") {
    return { maxCommentsPerItem: MAX_COMMUNITY_COMMENTS };
  }
  const comments = Math.round(Number(deepBudget.maxCommentsPerItem ?? deepBudget.max_comments_per_item ?? deepBudget.maxComments ?? deepBudget.max_comments ?? MAX_COMMUNITY_COMMENTS));
  return {
    maxCommentsPerItem: Number.isFinite(comments) ? Math.min(MAX_COMMUNITY_COMMENTS, Math.max(0, comments)) : MAX_COMMUNITY_COMMENTS,
  };
}

function normalizeSubreddits(subreddits = []) {
  const raw = Array.isArray(subreddits)
    ? subreddits
    : typeof subreddits === "string"
      ? subreddits.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const value = cleanText(item, 120)
      .replace(/^https?:\/\/(?:www\.)?reddit\.com\/r\//i, "")
      .replace(/^\/?r\//i, "")
      .replace(/\/.*$/g, "")
      .replace(/[^\w-]/g, "")
      .slice(0, 40);
    if (value && !out.includes(value.toLowerCase())) out.push(value.toLowerCase());
    if (out.length >= 30) break;
  }
  return out;
}

function redditSearchTargets(subreddits = []) {
  return [
    ...DEFAULT_REDDIT_SEARCH_TARGETS,
    ...normalizeSubreddits(subreddits).map(subreddit => ({
      subreddit,
      label: `reddit-r-${subreddit}`,
    })),
  ];
}

function normalizeGitHubRepositories(repositories = []) {
  const raw = Array.isArray(repositories)
    ? repositories
    : typeof repositories === "string"
      ? repositories.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const item of raw) {
    let value = cleanText(item, 200)
      .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
      .replace(/^git@github\.com:/i, "")
      .replace(/\.git$/i, "");
    const segments = value.split("/").filter(Boolean);
    if (segments.length < 2) continue;
    value = `${segments[0]}/${segments[1]}`.replace(/[^\w./-]/g, "").toLowerCase();
    if (/^[\w.-]+\/[\w.-]+$/.test(value) && !out.includes(value)) out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}

function githubIssueSearchTargets(repositories = []) {
  return [
    ...DEFAULT_GITHUB_ISSUE_TARGETS,
    ...normalizeGitHubRepositories(repositories).map(repository => ({
      repository,
      label: `github-repo-${repository}`,
    })),
  ];
}

function normalizeHackerNewsAuthors(authors = []) {
  const raw = Array.isArray(authors)
    ? authors
    : typeof authors === "string"
      ? authors.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const value = cleanText(item, 120)
      .replace(/^https?:\/\/news\.ycombinator\.com\/user\?id=/i, "")
      .replace(/^@/, "")
      .replace(/[^\w-]/g, "")
      .slice(0, 40);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}

function hackerNewsSearchTargets(authors = []) {
  return [
    ...DEFAULT_HACKER_NEWS_SEARCH_TARGETS,
    ...normalizeHackerNewsAuthors(authors).map(author => ({
      author,
      label: `hackernews-author-${author}`,
    })),
  ];
}

function normalizeStackOverflowTags(tags = []) {
  const raw = Array.isArray(tags)
    ? tags
    : typeof tags === "string"
      ? tags.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const item of raw) {
    let value = cleanText(item, 120)
      .replace(/^https?:\/\/(?:www\.)?stackoverflow\.com\/questions\/tagged\//i, "")
      .replace(/^\/?questions\/tagged\//i, "")
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .replace(/\/.*$/g, "")
      .replace(/[^\w.+#-]/g, "")
      .toLowerCase()
      .slice(0, 60);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}

function stackOverflowSearchTargets(tags = []) {
  return [
    ...DEFAULT_STACK_OVERFLOW_SEARCH_TARGETS,
    ...normalizeStackOverflowTags(tags).map(tag => ({
      tag,
      label: `stackoverflow-tag-${tag}`,
    })),
  ];
}

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stripHtml(value, max = 1200) {
  return cleanText(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'"), max);
}

function normalizeIsoDate(value) {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function normalizeCommunityDedupeUrl(rawUrl = "") {
  const cleaned = cleanText(rawUrl, 1200);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeCommunityDedupeUrl(embedded);
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
      "context",
      "sort",
      "depth",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^old\.reddit\.com$/i, "reddit.com")
      .replace(/^new\.reddit\.com$/i, "reddit.com")
      .replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return cleaned.toLowerCase();
  }
}

function communityItemDedupeKey(item = {}) {
  return normalizeCommunityDedupeUrl(item?.url || "");
}

function normalizeCommunityKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function communityKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeCommunityKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts].filter(Boolean).map(part => String(part).toLowerCase()))].slice(0, 12);
}

function communityValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeCommunityKeywordText(value);
  return communityKeywordNeedles(keyword).some(needle => {
    const normalizedNeedle = normalizeCommunityKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function textMatchesKeyword(item, keyword) {
  return communityValueMatchesKeyword(`${item.title || ""} ${item.content || ""}`, keyword);
}

function communityKeywordMatchSource(item = {}, keyword = "") {
  if (!keyword) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
  ];
  return fields.find(([, value]) => communityValueMatchesKeyword(value || "", keyword))?.[0] || "search_query";
}

function withCommunityKeywordDiagnostics(item = {}, keyword = "") {
  item.metrics = {
    ...(item.metrics || {}),
    community_matched_keyword: cleanText(keyword, 160),
    community_keyword_match_source: communityKeywordMatchSource(item, keyword),
  };
  return item;
}

function communityTermMatches(value = "", terms = []) {
  const text = cleanText(value, 4000).toLowerCase();
  return [...new Set(terms.filter(term => text.includes(String(term).toLowerCase())))].slice(0, 16);
}

function communityCommentSignals(comment = {}) {
  const text = `${comment?.author || ""} ${comment?.content || ""}`;
  const riskTerms = communityTermMatches(text, [
    "complaint", "refund", "chargeback", "dispute", "support", "scam", "fraud", "outage", "incident", "bug",
    "breach", "leak", "security", "vulnerability", "投诉", "投訴", "退款", "客服", "詐騙", "诈骗", "故障", "安全", "漏洞", "泄露", "外洩",
  ]);
  const evidenceTerms = communityTermMatches(text, [
    "screenshot", "receipt", "evidence", "proof", "chat log", "order id", "timeline", "postmortem", "archive",
    "截图", "截圖", "凭证", "憑證", "证据", "證據", "聊天记录", "聊天紀錄", "订单", "訂單", "時間線", "时间线", "复盘", "復盤",
  ]);
  const responseTerms = communityTermMatches(text, [
    "official response", "public response", "support response", "maintainer", "confirmed", "acknowledged",
    "workaround", "resolved", "fixed", "patched", "apology", "clarification",
    "官方回應", "官方回应", "公開回應", "公开回应", "客服回應", "客服回应", "回應", "回应", "回覆", "回复",
    "處理進度", "处理进度", "確認", "确认", "已处理", "已處理", "修复", "修復", "道歉", "澄清",
  ]);
  const propagationTerms = communityTermMatches(text, [
    "viral", "spread", "spreading", "trending", "crosspost", "shared", "front page", "widely discussed",
    "megathread", "thread", "discussion", "comments", "扩散", "擴散", "热议", "熱議", "发酵", "發酵", "转发", "轉發", "討論", "讨论", "留言", "跟帖",
  ]);
  const reasons = [];
  if (riskTerms.length) reasons.push("comment-risk-language");
  if (evidenceTerms.length) reasons.push("comment-evidence-language");
  if (responseTerms.length) reasons.push("comment-response-language");
  if (propagationTerms.length) reasons.push("comment-propagation-language");
  const semanticCount = [riskTerms.length, evidenceTerms.length, responseTerms.length, propagationTerms.length].filter(Boolean).length;
  if (semanticCount >= 3) reasons.push("comment-complete-crisis-narrative");
  const likeCount = Number(comment?.metrics?.like_count || comment?.metrics?.score || 0);
  if (Number.isFinite(likeCount) && likeCount >= 5) reasons.push("comment-high-engagement");
  return {
    community_comment_risk_signal: riskTerms.length ? 1 : 0,
    community_comment_evidence_signal: evidenceTerms.length ? 1 : 0,
    community_comment_response_signal: responseTerms.length ? 1 : 0,
    community_comment_propagation_signal: propagationTerms.length ? 1 : 0,
    community_comment_semantic_signal_count: semanticCount,
    community_comment_complete_crisis_narrative_signal: semanticCount >= 3 ? 1 : 0,
    community_comment_risk_terms: riskTerms,
    community_comment_evidence_terms: evidenceTerms,
    community_comment_response_terms: responseTerms,
    community_comment_propagation_terms: propagationTerms,
    community_comment_signal_reasons: reasons,
  };
}

function withCommunityCommentSignals(comment = {}) {
  return {
    ...comment,
    metrics: {
      ...(comment.metrics || {}),
      ...communityCommentSignals(comment),
    },
  };
}

function aggregateCommunityCommentSignals(comments = []) {
  const rows = Array.isArray(comments) ? comments : [];
  const reasons = new Set();
  const riskTerms = new Set();
  const evidenceTerms = new Set();
  const responseTerms = new Set();
  const propagationTerms = new Set();
  let riskCount = 0;
  let evidenceCount = 0;
  let responseCount = 0;
  let propagationCount = 0;
  let completeNarrativeCount = 0;
  let highEngagementCount = 0;
  for (const comment of rows) {
    const signals = {
      ...communityCommentSignals(comment),
      ...(comment?.metrics || {}),
    };
    if (signals.community_comment_risk_signal) riskCount += 1;
    if (signals.community_comment_evidence_signal) evidenceCount += 1;
    if (signals.community_comment_response_signal) responseCount += 1;
    if (signals.community_comment_propagation_signal) propagationCount += 1;
    if (signals.community_comment_complete_crisis_narrative_signal) completeNarrativeCount += 1;
    if (Number(comment?.metrics?.like_count || comment?.metrics?.score || 0) >= 5) highEngagementCount += 1;
    for (const reason of signals.community_comment_signal_reasons || []) reasons.add(reason);
    for (const term of signals.community_comment_risk_terms || []) riskTerms.add(term);
    for (const term of signals.community_comment_evidence_terms || []) evidenceTerms.add(term);
    for (const term of signals.community_comment_response_terms || []) responseTerms.add(term);
    for (const term of signals.community_comment_propagation_terms || []) propagationTerms.add(term);
  }
  return {
    community_comment_depth_count: rows.length,
    community_comment_risk_count: riskCount,
    community_comment_evidence_count: evidenceCount,
    community_comment_response_count: responseCount,
    community_comment_propagation_count: propagationCount,
    community_comment_complete_crisis_narrative_count: completeNarrativeCount,
    community_comment_high_engagement_count: highEngagementCount,
    community_comment_depth_signal: rows.length > 0 ? 1 : 0,
    community_comment_risk_signal: riskCount > 0 ? 1 : 0,
    community_comment_evidence_signal: evidenceCount > 0 ? 1 : 0,
    community_comment_response_signal: responseCount > 0 ? 1 : 0,
    community_comment_propagation_signal: propagationCount > 0 ? 1 : 0,
    community_comment_complete_crisis_narrative_signal: completeNarrativeCount > 0 ? 1 : 0,
    community_comment_risk_terms: [...riskTerms].slice(0, 12),
    community_comment_evidence_terms: [...evidenceTerms].slice(0, 12),
    community_comment_response_terms: [...responseTerms].slice(0, 12),
    community_comment_propagation_terms: [...propagationTerms].slice(0, 12),
    community_comment_depth_reasons: [...reasons],
  };
}

function insertCommunityItem(item, { platform, keyword, domainControls = {}, contentControls = {}, failoverAttribution = [] }) {
  const content = cleanText(item.content || item.summary || "", 1200);
  const comments = Array.isArray(item.comments) ? item.comments.map(withCommunityCommentSignals) : [];
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  const sentiment = analyzeSentiment(`${item.title} ${content}`);
  const result = insertSentimentItem({
    platform,
    url: item.url,
    title: item.title,
    content,
    author: item.author,
    sentiment,
    risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
    keyword,
    keywords: [keyword],
    published_at: item.publishedAt,
    ai_summary: content,
    evidence: {
      evidence_type: item.evidenceType || "community_post",
      metrics: {
        ...(item.metrics || {}),
        ...aggregateCommunityCommentSignals(comments),
        community_canonical_dedupe_url: communityItemDedupeKey(item),
        community_search_scan_dedupe_key: communityItemDedupeKey(item),
        ...(attribution.length ? {
          failover_attribution: attribution,
          failover_from_sources: failoverFromSources,
        } : {}),
      },
    },
    comments,
    source_type: "scraper",
    domainControls,
    contentControls,
  });
  return result.inserted ? 1 : 0;
}

function parseGitHubIssueComments(payload, limit = MAX_COMMUNITY_COMMENTS) {
  const comments = Array.isArray(payload) ? payload : [];
  return comments.map(comment => {
    const content = cleanText(comment.body || "", 1200);
    const commentId = cleanText(comment.id || comment.node_id || "", 160);
    const reactions = Number(comment.reactions?.total_count || 0);
    return withCommunityCommentSignals({
      external_id: commentId,
      author: cleanText(comment.user?.login || "GitHub", 160),
      content,
      published_at: normalizeIsoDate(comment.updated_at || comment.created_at),
      metrics: {
        like_count: reactions,
        github_comment_id: commentId,
        github_comment_reactions: reactions,
      },
    });
  }).filter(comment => comment.content).slice(0, limit);
}

function githubIssueReference(item = {}) {
  const htmlUrl = cleanText(item.html_url || item.url || "", 800);
  const repositoryUrl = cleanText(item.repository_url || "", 500);
  let repository = repositoryUrl.replace(/^https:\/\/api\.github\.com\/repos\//i, "");
  let owner = "";
  let repo = "";
  let issueNumber = cleanText(item.number || "", 80);
  try {
    const parsed = new URL(htmlUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname.replace(/^www\./i, "").toLowerCase() === "github.com" && segments.length >= 4 && segments[2] === "issues") {
      owner = cleanText(segments[0], 120);
      repo = cleanText(segments[1], 120);
      repository = repository || `${owner}/${repo}`;
      issueNumber = issueNumber || cleanText(segments[3], 80);
    }
  } catch {
    // Keep repository_url-derived values below.
  }
  if ((!owner || !repo) && repository.includes("/")) {
    const parts = repository.split("/");
    owner = cleanText(parts[0], 120);
    repo = cleanText(parts[1], 120);
  }
  return {
    repository,
    owner,
    repo,
    issueNumber,
    issueUrl: htmlUrl,
  };
}

function githubIssueSignals({ title = "", content = "", state = "", labels = [], comments = 0, reactions = 0 } = {}) {
  const labelText = Array.isArray(labels) ? labels.map(label => label?.name || label).join(" ") : String(labels || "");
  const source = cleanText(`${title} ${content} ${state} ${labelText}`, 2200).toLowerCase();
  const complaint = /complaint|refund|support|customer service|billing|chargeback|dispute|投诉|投訴|退款|客服|爭議|争议|扣款/.test(source);
  const outage = /outage|incident|downtime|status|postmortem|degradation|bug|regression|故障|宕机|當機|事故|异常|異常|回歸|回归/.test(source);
  const security = /security|vulnerability|cve|exploit|breach|leak|phishing|xss|csrf|rce|资安|資安|安全|漏洞|外洩|泄露|釣魚|钓鱼/.test(source);
  const maintainerResponse = /maintainer|triage|confirmed|acknowledged|repro|workaround|fix pending|patched|修复|修復|確認|确认|復現|复现|已处理|已處理|臨時方案|临时方案/.test(source);
  const escalation = Number(comments || 0) >= 3 || Number(reactions || 0) >= 5 || /escalation|urgent|critical|blocker|priority|sev[ -]?[0-2]|p[ -]?[0-1]|緊急|紧急|嚴重|严重|高優先|高优先|阻塞/.test(source);
  const closed = String(state || "").toLowerCase() === "closed";
  const reasons = [];
  if (complaint) reasons.push("complaint-language");
  if (outage) reasons.push("outage-bug-language");
  if (security) reasons.push("security-language");
  if (maintainerResponse) reasons.push("maintainer-response-language");
  if (escalation) reasons.push("escalation-engagement-signal");
  if (closed) reasons.push("closed-state");
  return {
    github_complaint_signal: complaint ? 1 : 0,
    github_outage_signal: outage ? 1 : 0,
    github_security_signal: security ? 1 : 0,
    github_maintainer_response_signal: maintainerResponse ? 1 : 0,
    github_escalation_signal: escalation ? 1 : 0,
    github_closed_signal: closed ? 1 : 0,
    github_signal_count: reasons.length,
    github_signal_reasons: reasons,
  };
}

function redditCommentsUrlFromPostUrl(url) {
  const cleanedUrl = cleanText(url || "", 800).replace(/\/+$/g, "");
  if (!cleanedUrl || !/reddit\.com/i.test(cleanedUrl)) return "";
  if (cleanedUrl.endsWith(".json")) return cleanedUrl;
  return `${cleanedUrl}.json?limit=${MAX_COMMUNITY_COMMENTS}&sort=confidence`;
}

function redditPostReference(url = "", fallbackSubreddit = "") {
  try {
    const parsed = new URL(cleanText(url, 800));
    const host = parsed.hostname.replace(/^www\./i, "").replace(/^old\./i, "").replace(/^new\./i, "").toLowerCase();
    if (host !== "reddit.com") return { subreddit: cleanText(fallbackSubreddit, 160), postId: "", slug: "" };
    const segments = parsed.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex(segment => segment.toLowerCase() === "comments");
    if (segments[0]?.toLowerCase() === "r" && commentsIndex >= 2) {
      return {
        subreddit: cleanText(`r/${segments[1] || ""}`, 160),
        postId: cleanText(segments[commentsIndex + 1] || "", 80),
        slug: cleanText(segments[commentsIndex + 2] || "", 220),
      };
    }
    return { subreddit: cleanText(fallbackSubreddit, 160), postId: cleanText(segments[commentsIndex + 1] || "", 80), slug: "" };
  } catch {
    return { subreddit: cleanText(fallbackSubreddit, 160), postId: "", slug: "" };
  }
}

function redditDiscussionSignals({ title = "", content = "", score = 0, comments = 0, upvoteRatio = null } = {}) {
  const source = cleanText(`${title} ${content}`, 1800).toLowerCase();
  const complaint = /complaint|refund|chargeback|dispute|support|scam|fraud|outage|bug|投诉|投訴|客诉|客訴|退款|退货|退貨|詐騙|诈骗|客服|故障/.test(source);
  const boycott = /boycott|avoid|warning|do not buy|don't buy|cancel|避雷|踩雷|抵制|不要买|不要買|劝退|勸退|黑名单|黑名單/.test(source);
  const evidence = /screenshot|receipt|evidence|proof|chat log|order id|截图|截圖|凭证|憑證|证据|證據|聊天记录|聊天紀錄|订单|訂單/.test(source);
  const amplification = /viral|spread|spreading|trending|crosspost|shared|x-post|megathread|扩散|擴散|热议|熱議|发酵|發酵|转发|轉發|爆料|曝光/.test(source);
  const discussion = Number(comments || 0) > 0 || /comment|reply|thread|discussion|评论|評論|留言|回复|回覆|討論|讨论/.test(source);
  const controversial = upvoteRatio !== null && Number.isFinite(Number(upvoteRatio)) && Number(upvoteRatio) > 0 && Number(upvoteRatio) < 0.65 && Number(comments || 0) >= 3;
  const reasons = [];
  if (complaint) reasons.push("complaint-language");
  if (boycott) reasons.push("boycott-avoidance-language");
  if (evidence) reasons.push("evidence-language");
  if (amplification) reasons.push("amplification-language");
  if (discussion) reasons.push("comment-discussion-signal");
  if (controversial) reasons.push("controversial-engagement-signal");
  return {
    reddit_complaint_signal: complaint ? 1 : 0,
    reddit_boycott_signal: boycott ? 1 : 0,
    reddit_evidence_signal: evidence ? 1 : 0,
    reddit_amplification_signal: amplification ? 1 : 0,
    reddit_discussion_signal: discussion ? 1 : 0,
    reddit_controversial_signal: controversial ? 1 : 0,
    reddit_signal_count: reasons.length,
    reddit_signal_reasons: reasons,
  };
}

function parseRedditComments(payload, limit = MAX_COMMUNITY_COMMENTS) {
  const commentListing = Array.isArray(payload) ? payload[1] : null;
  const children = Array.isArray(commentListing?.data?.children) ? commentListing.data.children : [];
  return children.map(child => {
    if (child?.kind === "more") return null;
    const comment = child?.data || {};
    const content = cleanText(comment.body || "", 1200);
    const commentId = cleanText(comment.name || comment.id || "", 160);
    return withCommunityCommentSignals({
      external_id: commentId,
      author: cleanText(comment.author || "reddit", 160),
      content,
      published_at: normalizeIsoDate(comment.created_utc || comment.created),
      metrics: {
        like_count: Number(comment.score || 0),
        reddit_comment_id: commentId,
        reddit_comment_score: Number(comment.score || 0),
      },
    });
  }).filter(comment => comment?.content).slice(0, limit);
}

function parseHackerNewsComments(payload, limit = MAX_COMMUNITY_COMMENTS) {
  const comments = [];
  const visit = (nodes = [], depth = 0) => {
    if (!Array.isArray(nodes) || comments.length >= limit) return;
    for (const node of nodes) {
      if (comments.length >= limit) break;
      const text = stripHtml(node?.text || node?.comment_text || "", 1200);
      if (text) {
        const commentId = cleanText(node.id || node.objectID || "", 160);
        comments.push(withCommunityCommentSignals({
          external_id: commentId,
          author: cleanText(node.author || "Hacker News", 160),
          content: text,
          published_at: normalizeIsoDate(node.created_at_i || node.created_at),
          metrics: {
            depth,
            hacker_news_comment_id: commentId,
            hacker_news_comment_depth: depth,
          },
        }));
      }
      visit(node?.children || [], depth + 1);
    }
  };
  visit(payload?.children || [], 0);
  return comments.slice(0, limit);
}

function hostFromUrl(value = "") {
  try {
    return new URL(cleanText(value, 800)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hackerNewsItemReference(hit = {}) {
  const objectId = cleanText(hit.objectID || hit.story_id || hit.id || "", 80);
  const externalUrl = cleanText(hit.url || "", 800);
  return {
    objectId,
    itemUrl: objectId ? `https://news.ycombinator.com/item?id=${encodeURIComponent(objectId)}` : "",
    externalUrl,
    externalHost: hostFromUrl(externalUrl),
  };
}

function hackerNewsDiscussionSignals({ title = "", content = "", points = 0, comments = 0 } = {}) {
  const source = cleanText(`${title} ${content}`, 1800).toLowerCase();
  const complaint = /complaint|refund|support|customer service|scam|fraud|dispute|投诉|投訴|退款|客服|詐騙|诈骗|爭議|争议/.test(source);
  const outage = /outage|incident|downtime|status page|postmortem|root cause|degradation|故障|宕机|當機|事故|狀態頁|状态页|事后|事後|根因/.test(source);
  const security = /security|breach|vulnerability|cve|exploit|leak|phishing|资安|資安|安全|漏洞|外洩|泄露|釣魚|钓鱼/.test(source);
  const investigation = /investigation|lawsuit|regulator|enforcement|whistleblower|investor|調查|调查|訴訟|诉讼|監管|监管|執法|执法|吹哨/.test(source);
  const discussion = Number(comments || 0) > 0 || /discussion|comments|debate|ask hn|show hn|討論|讨论|留言|評論|评论/.test(source);
  const amplification = Number(points || 0) >= 25 || Number(comments || 0) >= 10 || /front page|viral|spread|trending|widely discussed|擴散|扩散|熱議|热议|發酵|发酵/.test(source);
  const reasons = [];
  if (complaint) reasons.push("complaint-language");
  if (outage) reasons.push("outage-incident-language");
  if (security) reasons.push("security-language");
  if (investigation) reasons.push("investigation-language");
  if (discussion) reasons.push("comment-discussion-signal");
  if (amplification) reasons.push("amplification-engagement-signal");
  return {
    hacker_news_complaint_signal: complaint ? 1 : 0,
    hacker_news_outage_signal: outage ? 1 : 0,
    hacker_news_security_signal: security ? 1 : 0,
    hacker_news_investigation_signal: investigation ? 1 : 0,
    hacker_news_discussion_signal: discussion ? 1 : 0,
    hacker_news_amplification_signal: amplification ? 1 : 0,
    hacker_news_signal_count: reasons.length,
    hacker_news_signal_reasons: reasons,
  };
}

function parseStackOverflowAnswers(payload, limit = MAX_COMMUNITY_COMMENTS) {
  const answers = Array.isArray(payload?.items) ? payload.items : [];
  return answers.map(answer => {
    const content = stripHtml(answer.body || "", 1200);
    const answerId = cleanText(answer.answer_id || "", 160);
    const score = Number(answer.score || 0);
    const accepted = answer.is_accepted === true;
    return withCommunityCommentSignals({
      external_id: answerId,
      author: cleanText(answer.owner?.display_name || "Stack Overflow", 160),
      content,
      published_at: normalizeIsoDate(answer.last_activity_date || answer.creation_date),
      metrics: {
        like_count: score,
        is_accepted: accepted,
        stack_overflow_answer_id: answerId,
        stack_overflow_answer_score: score,
        stack_overflow_answer_accepted: accepted ? 1 : 0,
      },
    });
  }).filter(answer => answer.content).slice(0, limit);
}

function stackOverflowQuestionReference(item = {}) {
  const link = cleanText(item.link || item.url || "", 800);
  let questionId = cleanText(item.question_id || "", 80);
  let slug = "";
  try {
    const parsed = new URL(link);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const questionsIndex = segments.findIndex(segment => segment.toLowerCase() === "questions");
    if (questionsIndex >= 0) {
      questionId = questionId || cleanText(segments[questionsIndex + 1] || "", 80);
      slug = cleanText(segments[questionsIndex + 2] || "", 220);
    }
  } catch {
    // Keep API-provided question id.
  }
  return {
    questionId,
    questionUrl: link,
    questionSlug: slug,
  };
}

function stackOverflowQuestionSignals({ title = "", tags = [], score = 0, answers = 0, views = 0, isAnswered = false, acceptedAnswerId = "" } = {}) {
  const tagText = Array.isArray(tags) ? tags.join(" ") : String(tags || "");
  const source = cleanText(`${title} ${tagText}`, 1800).toLowerCase();
  const support = /support|customer-service|billing|refund|complaint|客服|退款|投訴|投诉|客訴|客诉/.test(source);
  const outage = /outage|incident|downtime|timeout|rate-limit|api|bug|error|exception|故障|宕机|當機|事故|超时|超時|錯誤|错误|異常|异常/.test(source);
  const security = /security|oauth|token|auth|vulnerability|cve|xss|csrf|rce|leak|phishing|資安|资安|安全|漏洞|外洩|泄露|釣魚|钓鱼/.test(source);
  const unresolved = !isAnswered && !acceptedAnswerId;
  const answered = isAnswered || Boolean(acceptedAnswerId);
  const highVisibility = Number(views || 0) >= 1000 || Number(score || 0) >= 5 || Number(answers || 0) >= 3;
  const reasons = [];
  if (support) reasons.push("support-complaint-language");
  if (outage) reasons.push("outage-error-language");
  if (security) reasons.push("security-auth-language");
  if (unresolved) reasons.push("unresolved-question-signal");
  if (answered) reasons.push("answered-question-signal");
  if (highVisibility) reasons.push("high-visibility-engagement-signal");
  return {
    stack_overflow_support_signal: support ? 1 : 0,
    stack_overflow_outage_signal: outage ? 1 : 0,
    stack_overflow_security_signal: security ? 1 : 0,
    stack_overflow_unresolved_signal: unresolved ? 1 : 0,
    stack_overflow_answered_signal: answered ? 1 : 0,
    stack_overflow_high_visibility_signal: highVisibility ? 1 : 0,
    stack_overflow_signal_count: reasons.length,
    stack_overflow_signal_reasons: reasons,
  };
}

async function fetchGitHubIssueComments(item, { proxyUrl = "", maxComments = MAX_COMMUNITY_COMMENTS } = {}) {
  const limit = Math.max(0, Math.min(MAX_COMMUNITY_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.commentsUrl || Number(item?.metrics?.comments || 0) <= 0) return [];
  try {
    const res = await fetchPublicSource(item.commentsUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseGitHubIssueComments(await res.json(), limit);
  } catch {
    return [];
  }
}

async function fetchRedditPostComments(item, { proxyUrl = "", maxComments = MAX_COMMUNITY_COMMENTS } = {}) {
  const limit = Math.max(0, Math.min(MAX_COMMUNITY_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.commentsUrl || Number(item?.metrics?.comments || 0) <= 0) return [];
  try {
    const res = await fetchPublicSource(item.commentsUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseRedditComments(await res.json(), limit);
  } catch {
    return [];
  }
}

async function fetchHackerNewsComments(item, { proxyUrl = "", maxComments = MAX_COMMUNITY_COMMENTS } = {}) {
  const limit = Math.max(0, Math.min(MAX_COMMUNITY_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.commentsUrl || Number(item?.metrics?.comments || 0) <= 0) return [];
  try {
    const res = await fetchPublicSource(item.commentsUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseHackerNewsComments(await res.json(), limit);
  } catch {
    return [];
  }
}

async function fetchStackOverflowAnswers(item, { proxyUrl = "", maxComments = MAX_COMMUNITY_COMMENTS } = {}) {
  const limit = Math.max(0, Math.min(MAX_COMMUNITY_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.answersUrl || Number(item?.metrics?.answers || 0) <= 0) return [];
  try {
    const res = await fetchPublicSource(item.answersUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseStackOverflowAnswers(await res.json(), limit);
  } catch {
    return [];
  }
}

function parseGitHubIssues(payload, keyword, limit = 10, since = "") {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map(item => {
    const reference = githubIssueReference(item);
    const repository = reference.repository;
    const title = cleanText(item.title || "", 300);
    const body = cleanText(item.body || item.text_matches?.map(match => match.fragment).join(" ") || "", 1200);
    const labels = Array.isArray(item.labels) ? item.labels : [];
    const reactions = Number(item.reactions?.total_count || 0);
    const comments = Number(item.comments || 0);
    const signals = githubIssueSignals({
      title,
      content: body,
      state: item.state || "",
      labels,
      comments,
      reactions,
    });
    return withCommunityKeywordDiagnostics({
      url: cleanText(item.html_url || "", 800),
      title,
      content: body || cleanText(`${item.state || ""} ${repository}`, 1200),
      author: cleanText(item.user?.login || repository || "GitHub", 160),
      publishedAt: normalizeIsoDate(item.updated_at || item.created_at),
      commentsUrl: cleanText(item.comments_url || "", 800),
      evidenceType: "github_issue",
      metrics: {
        repository,
        github_repository: repository,
        github_repository_owner: reference.owner,
        github_repository_name: reference.repo,
        github_issue_number: reference.issueNumber,
        github_issue_url: reference.issueUrl,
        state: item.state || "",
        github_issue_state: item.state || "",
        comments,
        github_comment_count: comments,
        github_reaction_count: reactions,
        github_labels: labels.map(label => cleanText(label?.name || label, 120)).filter(Boolean).join(","),
        github_engagement_score: comments * 2 + reactions,
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseRedditPosts(payload, keyword, limit = 10, since = "") {
  const children = Array.isArray(payload?.data?.children) ? payload.data.children : [];
  return children.map(child => child?.data || {}).map(post => {
    const permalink = cleanText(post.permalink || "", 800);
    const url = permalink.startsWith("http")
      ? permalink
      : permalink
        ? `https://www.reddit.com${permalink}`
        : cleanText(post.url || "", 800);
    const subreddit = cleanText(post.subreddit_name_prefixed || post.subreddit || "reddit", 160);
    const reference = redditPostReference(url, subreddit);
    const title = cleanText(post.title || "", 300);
    const content = cleanText(post.selftext || post.link_flair_text || subreddit, 1200);
    const score = Number(post.score || 0);
    const comments = Number(post.num_comments || 0);
    const upvoteRatio = post.upvote_ratio === undefined || post.upvote_ratio === null ? null : Number(post.upvote_ratio);
    const signals = redditDiscussionSignals({ title, content, score, comments, upvoteRatio });
    return withCommunityKeywordDiagnostics({
      url,
      title,
      content,
      author: cleanText(post.author || subreddit, 160),
      publishedAt: normalizeIsoDate(post.created_utc || post.created),
      commentsUrl: redditCommentsUrlFromPostUrl(url),
      evidenceType: "reddit_post",
      metrics: {
        subreddit,
        reddit_subreddit: reference.subreddit || subreddit,
        reddit_post_id: cleanText(post.name || post.id || reference.postId, 160).replace(/^t3_/, ""),
        reddit_post_slug: reference.slug,
        score,
        comments,
        reddit_score: score,
        reddit_comment_count: comments,
        reddit_upvote_ratio: Number.isFinite(upvoteRatio) ? upvoteRatio : null,
        reddit_engagement_score: Math.max(0, score) + (comments * 2),
        over_18: post.over_18 === true,
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseHackerNewsHits(payload, keyword, limit = 10, since = "") {
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  return hits.map(hit => {
    const reference = hackerNewsItemReference(hit);
    const objectId = reference.objectId;
    const title = cleanText(hit.title || hit.story_title || hit.comment_text || "", 300);
    const content = cleanText([
      hit.story_text,
      hit.comment_text,
      hit.url,
      hit._tags?.join(" "),
    ].filter(Boolean).join(" "), 1200);
    const points = Number(hit.points || 0);
    const comments = Number(hit.num_comments || 0);
    const signals = hackerNewsDiscussionSignals({ title, content, points, comments });
    const url = cleanText(reference.externalUrl || reference.itemUrl, 800);
    return withCommunityKeywordDiagnostics({
      url,
      title,
      content,
      author: cleanText(hit.author || "Hacker News", 160),
      publishedAt: normalizeIsoDate(hit.created_at_i || hit.created_at),
      commentsUrl: objectId ? `https://hn.algolia.com/api/v1/items/${encodeURIComponent(objectId)}` : "",
      evidenceType: "hacker_news_item",
      metrics: {
        object_id: objectId,
        hacker_news_object_id: objectId,
        hacker_news_item_url: reference.itemUrl,
        hacker_news_external_url: reference.externalUrl,
        hacker_news_external_host: reference.externalHost,
        points,
        comments,
        hacker_news_points: points,
        hacker_news_comment_count: comments,
        hacker_news_engagement_score: Math.max(0, points) + (comments * 2),
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseStackOverflowItems(payload, keyword, limit = 10, since = "") {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map(item => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const reference = stackOverflowQuestionReference(item);
    const questionId = reference.questionId;
    const title = cleanText(item.title || "", 300);
    const content = cleanText(tags.join(" "), 1200);
    const score = Number(item.score || 0);
    const answers = Number(item.answer_count || 0);
    const views = Number(item.view_count || 0);
    const acceptedAnswerId = cleanText(item.accepted_answer_id || "", 80);
    const isAnswered = item.is_answered === true || Boolean(acceptedAnswerId);
    const signals = stackOverflowQuestionSignals({ title, tags, score, answers, views, isAnswered, acceptedAnswerId });
    return withCommunityKeywordDiagnostics({
      url: reference.questionUrl,
      title,
      content,
      author: cleanText(item.owner?.display_name || "Stack Overflow", 160),
      publishedAt: normalizeIsoDate(item.last_activity_date || item.creation_date),
      answersUrl: questionId ? `https://api.stackexchange.com/2.3/questions/${encodeURIComponent(questionId)}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=${MAX_COMMUNITY_COMMENTS}` : "",
      evidenceType: "stack_overflow_question",
      metrics: {
        question_id: questionId,
        stack_overflow_question_id: questionId,
        stack_overflow_question_url: reference.questionUrl,
        stack_overflow_question_slug: reference.questionSlug,
        site: "stackoverflow",
        score,
        answers,
        views,
        stack_overflow_score: score,
        stack_overflow_answer_count: answers,
        stack_overflow_view_count: views,
        stack_overflow_is_answered: isAnswered ? 1 : 0,
        stack_overflow_accepted_answer_id: acceptedAnswerId,
        stack_overflow_engagement_score: Math.max(0, score) + (answers * 2) + Math.floor(Math.max(0, views) / 100),
        tags: tags.join(","),
        stack_overflow_tags: tags.join(","),
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

export async function scrapeGitHubIssues(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, repositories = [], repos = [], failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const targets = githubIssueSearchTargets(repositories?.length ? repositories : repos);
  const seenItemUrls = new Set();

  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of targets) tasks.push({ keyword, target });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      const query = `${keyword} in:title,body is:issue${target.repository ? ` repo:${target.repository}` : ""}`;
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const perPage = Math.min(50, normalizedBudget.maxItemsPerKeyword);
        const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${target.label}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawItems = Array.isArray(payload?.items) ? payload.items : [];
        const items = parseGitHubIssues(payload, keyword, normalizedBudget.maxItemsPerKeyword - inserted, since);
        if (!items.length && !rawItems.length) break;
        for (const item of items) {
          const dedupeKey = communityItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchGitHubIssueComments(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem });
          inserted += insertCommunityItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              search_scope: target.repository ? "repository" : "global",
              search_repository: target.repository || "",
              community_search_page: page,
              community_search_raw_result_count: rawItems.length,
            },
          }, { platform: "github_issues", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/GitHubIssues] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeReddit(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, subreddits = [], subreddit = [], failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const targets = redditSearchTargets(subreddits?.length ? subreddits : subreddit);
  const seenItemUrls = new Set();

  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of targets) tasks.push({ keyword, target });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      let after = "";
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const params = new URLSearchParams({
          q: keyword,
          sort: "new",
          t: "week",
          limit: String(Math.min(50, normalizedBudget.maxItemsPerKeyword)),
        });
        if (target.subreddit) params.set("restrict_sr", "1");
        if (after) params.set("after", after);
        const url = target.subreddit
          ? `https://www.reddit.com/r/${encodeURIComponent(target.subreddit)}/search.json?${params.toString()}`
          : `https://www.reddit.com/search.json?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${target.label}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawChildren = Array.isArray(payload?.data?.children) ? payload.data.children : [];
        const nextAfter = cleanText(payload?.data?.after || "", 120);
        const items = parseRedditPosts(payload, keyword, normalizedBudget.maxItemsPerKeyword - inserted, since);
        if (!items.length && (!nextAfter || !rawChildren.length)) break;
        for (const item of items) {
          const dedupeKey = communityItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchRedditPostComments(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem });
          inserted += insertCommunityItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              search_scope: target.subreddit ? "subreddit" : "global",
              search_subreddit: target.subreddit || "",
              community_search_page: page,
              community_search_raw_result_count: rawChildren.length,
            },
          }, { platform: "reddit", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
        after = nextAfter;
        if (!after) break;
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/Reddit] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeHackerNews(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, authors = [], author = [], failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const targets = hackerNewsSearchTargets(authors?.length ? authors : author);
  const seenItemUrls = new Set();

  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of targets) tasks.push({ keyword, target });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      for (let page = 0; page < normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const tags = target.author ? `story,author_${target.author}` : "story";
        const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(keyword)}&tags=${encodeURIComponent(tags)}&hitsPerPage=${Math.min(50, normalizedBudget.maxItemsPerKeyword)}&page=${page}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${target.label}:page:${page + 1}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawHits = Array.isArray(payload?.hits) ? payload.hits : [];
        const items = parseHackerNewsHits(payload, keyword, normalizedBudget.maxItemsPerKeyword - inserted, since);
        if (!items.length && !rawHits.length) break;
        for (const item of items) {
          const dedupeKey = communityItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchHackerNewsComments(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem });
          inserted += insertCommunityItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              search_scope: target.author ? "author" : "global",
              search_author: target.author || "",
              community_search_page: page + 1,
              community_search_raw_result_count: rawHits.length,
            },
          }, { platform: "hacker_news", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.label, message });
      console.warn(`[CRM/HackerNews] 抓取失敗 target=${target.label} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeStackOverflow(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, tags = [], tag = [], failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const targets = stackOverflowSearchTargets(tags?.length ? tags : tag);
  const seenItemUrls = new Set();

  const tasks = [];
  for (const keyword of normalizedKeywords) {
    for (const target of targets) tasks.push({ keyword, target });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const params = new URLSearchParams({
          order: "desc",
          sort: "activity",
          q: keyword,
          site: "stackoverflow",
          pagesize: String(Math.min(50, normalizedBudget.maxItemsPerKeyword)),
          page: String(page),
        });
        if (target.tag) params.set("tagged", target.tag);
        const url = `https://api.stackexchange.com/2.3/search/advanced?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${target.label}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawItems = Array.isArray(payload?.items) ? payload.items : [];
        const hasMore = payload?.has_more === true;
        const items = parseStackOverflowItems(payload, keyword, normalizedBudget.maxItemsPerKeyword - inserted, since);
        if (!items.length && (!hasMore || !rawItems.length)) break;
        for (const item of items) {
          const dedupeKey = communityItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchStackOverflowAnswers(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem });
          inserted += insertCommunityItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              search_scope: target.tag ? "tag" : "global",
              search_tag: target.tag || "",
              community_search_page: page,
              community_search_raw_result_count: rawItems.length,
            },
          }, { platform: "stack_overflow", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.label, message });
      console.warn(`[CRM/StackOverflow] 抓取失敗 target=${target.label} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  normalizeCommunityDedupeUrl,
  communityItemDedupeKey,
  normalizeCommunityKeywordText,
  communityKeywordNeedles,
  communityValueMatchesKeyword,
  textMatchesKeyword,
  communityKeywordMatchSource,
  withCommunityKeywordDiagnostics,
  communityTermMatches,
  communityCommentSignals,
  withCommunityCommentSignals,
  aggregateCommunityCommentSignals,
  parseGitHubIssues,
  parseGitHubIssueComments,
  githubIssueReference,
  githubIssueSignals,
  parseRedditPosts,
  parseRedditComments,
  redditCommentsUrlFromPostUrl,
  redditPostReference,
  redditDiscussionSignals,
  parseHackerNewsHits,
  parseHackerNewsComments,
  hackerNewsItemReference,
  hackerNewsDiscussionSignals,
  normalizeHackerNewsAuthors,
  hackerNewsSearchTargets,
  parseStackOverflowItems,
  parseStackOverflowAnswers,
  stackOverflowQuestionReference,
  stackOverflowQuestionSignals,
  normalizeBudget,
  normalizeDeepBudget,
  normalizeSubreddits,
  redditSearchTargets,
  normalizeGitHubRepositories,
  githubIssueSearchTargets,
  normalizeStackOverflowTags,
  stackOverflowSearchTargets,
};
