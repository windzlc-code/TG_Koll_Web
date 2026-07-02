import { mapWithConcurrency } from "./concurrency.js";
import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 10;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 3;
const MAX_FEDERATED_COMMENTS = 20;
const DEFAULT_LEMMY_INSTANCES = [
  "https://lemmy.world",
  "https://lemmy.ml",
  "https://beehaw.org",
];
export const DISCOURSE_FORUM_TARGETS = [
  {
    key: "metaDiscourse",
    name: "Discourse Meta",
    url: "https://meta.discourse.org",
    profiles: ["global", "community", "forum", "platform", "support", "developer"],
    tags: ["discourse", "support", "community"],
    tier: "product-community",
  },
  {
    key: "openaiCommunity",
    name: "OpenAI Community",
    url: "https://community.openai.com",
    profiles: ["global", "community", "forum", "ai", "saas", "developer", "support"],
    tags: ["ai", "developer", "support", "product-community"],
    tier: "product-community",
  },
  {
    key: "sentryForum",
    name: "Sentry Forum",
    url: "https://forum.sentry.io",
    profiles: ["global", "community", "forum", "saas", "developer", "support"],
    tags: ["saas", "developer", "support", "incident"],
    tier: "product-community",
  },
  {
    key: "cloudflareCommunity",
    name: "Cloudflare Community",
    url: "https://community.cloudflare.com",
    profiles: ["global", "community", "forum", "saas", "developer", "infrastructure", "support", "outage"],
    tags: ["infrastructure", "outage", "support", "product-community"],
    tier: "product-community",
  },
  {
    key: "elasticDiscuss",
    name: "Elastic Discuss",
    url: "https://discuss.elastic.co",
    profiles: ["global", "community", "forum", "developer", "opensource", "saas", "support"],
    tags: ["developer", "opensource", "support", "product-community"],
    tier: "product-community",
  },
  {
    key: "grafanaCommunity",
    name: "Grafana Community",
    url: "https://community.grafana.com",
    profiles: ["global", "community", "forum", "developer", "opensource", "saas", "support"],
    tags: ["developer", "opensource", "support", "product-community"],
    tier: "product-community",
  },
  {
    key: "homeAssistantCommunity",
    name: "Home Assistant Community",
    url: "https://community.home-assistant.io",
    profiles: ["global", "community", "forum", "consumer", "iot", "opensource", "support"],
    tags: ["consumer", "iot", "opensource", "support"],
    tier: "product-community",
  },
  {
    key: "braveCommunity",
    name: "Brave Community",
    url: "https://community.brave.com",
    profiles: ["global", "community", "forum", "consumer", "browser", "privacy", "support"],
    tags: ["consumer", "privacy", "support", "product-community"],
    tier: "product-community",
  },
  {
    key: "mozillaDiscourse",
    name: "Mozilla Discourse",
    url: "https://discourse.mozilla.org",
    profiles: ["global", "community", "forum", "consumer", "browser", "opensource", "privacy", "support"],
    tags: ["consumer", "opensource", "privacy", "support"],
    tier: "product-community",
  },
];
const DEFAULT_DISCOURSE_SITES = DISCOURSE_FORUM_TARGETS.map(target => target.url);
const DEFAULT_GITLAB_ISSUE_TARGETS = [{ project: "", label: "gitlab-global" }];

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

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
    return { maxCommentsPerItem: MAX_FEDERATED_COMMENTS };
  }
  const comments = Math.round(Number(deepBudget.maxCommentsPerItem ?? deepBudget.max_comments_per_item ?? deepBudget.maxComments ?? deepBudget.max_comments ?? MAX_FEDERATED_COMMENTS));
  return {
    maxCommentsPerItem: Number.isFinite(comments) ? Math.min(MAX_FEDERATED_COMMENTS, Math.max(0, comments)) : MAX_FEDERATED_COMMENTS,
  };
}

function normalizeIsoDate(value) {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function normalizeFederatedDedupeUrl(rawUrl = "") {
  const cleaned = cleanText(rawUrl, 1200);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeFederatedDedupeUrl(embedded);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ref",
      "ref_src",
      "source",
      "context",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return cleaned.toLowerCase();
  }
}

function federatedItemDedupeKey(item = {}) {
  return normalizeFederatedDedupeUrl(item?.url || "");
}

function normalizeSiteUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function normalizeProfileValues(values = []) {
  if (!values) return [];
  const raw = Array.isArray(values) ? values : String(values).split(/[,\s，、;；]+/);
  return raw.map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function discourseTargetMatchesProfiles(target = {}, targetProfiles = []) {
  const profiles = normalizeProfileValues(targetProfiles);
  if (!profiles.length) return true;
  const values = new Set([
    target.key,
    target.name,
    target.tier,
    ...(target.profiles || []),
    ...(target.tags || []),
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  return profiles.some(profile => values.has(profile));
}

function normalizeDiscourseSiteTargets(sites = [], targetProfiles = []) {
  const raw = Array.isArray(sites)
    ? sites
    : typeof sites === "string"
      ? sites.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const site of raw) {
    const normalized = normalizeSiteUrl(site);
    if (normalized && !out.some(target => target.url === normalized)) {
      out.push({
        key: normalized.replace(/^https?:\/\//i, "").replace(/[^\w.-]+/g, "-").toLowerCase(),
        name: normalized,
        url: normalized,
        profiles: ["custom", "community", "forum"],
        tags: ["custom", "community", "forum"],
        tier: "product-community",
      });
    }
    if (out.length >= 20) break;
  }
  if (out.length) return out;
  const candidates = DISCOURSE_FORUM_TARGETS.filter(target => discourseTargetMatchesProfiles(target, targetProfiles));
  return (candidates.length ? candidates : DISCOURSE_FORUM_TARGETS).slice(0, 20);
}

function normalizeDiscourseSites(sites = DEFAULT_DISCOURSE_SITES, targetProfiles = []) {
  return normalizeDiscourseSiteTargets(sites, targetProfiles).map(target => target.url);
}

function normalizeLemmyInstances(instances = DEFAULT_LEMMY_INSTANCES) {
  const raw = Array.isArray(instances)
    ? instances
    : typeof instances === "string"
      ? instances.split(/[,\n，、;；]+/)
      : DEFAULT_LEMMY_INSTANCES;
  const out = [];
  for (const instance of raw) {
    const normalized = normalizeSiteUrl(instance);
    if (normalized && !out.includes(normalized)) out.push(normalized);
    if (out.length >= 20) break;
  }
  return out.length ? out : [...DEFAULT_LEMMY_INSTANCES];
}

function normalizeGitLabProjects(projects = []) {
  const raw = Array.isArray(projects)
    ? projects
    : typeof projects === "string"
      ? projects.split(/[,\n，、;；]+/)
      : [];
  const out = [];
  for (const item of raw) {
    let value = cleanText(item, 240)
      .replace(/^https?:\/\/(?:www\.)?gitlab\.com\//i, "")
      .replace(/^git@gitlab\.com:/i, "")
      .replace(/\.git$/i, "");
    let segments = value.split("/").filter(Boolean);
    if (/^\d+$/.test(value)) {
      if (!out.includes(value)) out.push(value);
      continue;
    }
    const controlIndex = segments.indexOf("-");
    if (controlIndex >= 0) segments = segments.slice(0, controlIndex);
    if (segments.length < 2) continue;
    value = segments.slice(0, 8).join("/").replace(/[^\w./-]/g, "").toLowerCase();
    if (/^[\w.-]+(?:\/[\w.-]+)+$/.test(value) && !out.includes(value)) out.push(value);
    if (out.length >= 50) break;
  }
  return out;
}

function gitLabIssueSearchTargets(projects = []) {
  return [
    ...DEFAULT_GITLAB_ISSUE_TARGETS,
    ...normalizeGitLabProjects(projects).map(project => ({
      project,
      label: `gitlab-project-${project}`,
    })),
  ];
}

function normalizeFederatedKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function federatedKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeFederatedKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts].filter(Boolean).map(part => String(part).toLowerCase()))].slice(0, 12);
}

function federatedValueMatchesKeyword(value = "", keyword = "") {
  const lower = String(value || "").toLowerCase();
  const compact = normalizeFederatedKeywordText(value);
  return federatedKeywordNeedles(keyword).some(needle => {
    const normalizedNeedle = normalizeFederatedKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function textMatchesKeyword(item, keyword) {
  return federatedValueMatchesKeyword(`${item.title || ""} ${item.content || ""}`, keyword);
}

function federatedKeywordMatchSource(item = {}, keyword = "") {
  if (!keyword) return "search_query";
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["author", item.author],
    ["url", item.url],
  ];
  return fields.find(([, value]) => federatedValueMatchesKeyword(value || "", keyword))?.[0] || "search_query";
}

function withFederatedKeywordDiagnostics(item = {}, keyword = "") {
  item.metrics = {
    ...(item.metrics || {}),
    federated_matched_keyword: cleanText(keyword, 160),
    federated_keyword_match_source: federatedKeywordMatchSource(item, keyword),
  };
  return item;
}

function federatedCommentKeywordMatchSource(comment = {}, keyword = "") {
  if (!keyword) return "";
  const fields = [
    ["content", comment.content],
    ["author", comment.author],
    ["external_id", comment.external_id || comment.externalId || comment.id],
  ];
  return fields.find(([, value]) => federatedValueMatchesKeyword(value || "", keyword))?.[0] || "";
}

function withFederatedCommentKeywordDiagnostics(comment = {}, keyword = "") {
  if (!keyword) return comment;
  const matchSource = federatedCommentKeywordMatchSource(comment, keyword);
  return {
    ...comment,
    metrics: {
      ...(comment.metrics || {}),
      federated_comment_matched_keyword: cleanText(keyword, 160),
      federated_comment_keyword_match_source: matchSource,
      federated_comment_keyword_hit: Boolean(matchSource),
    },
  };
}

function insertFederatedItem(item, { platform, keyword, domainControls = {}, contentControls = {}, failoverAttribution = [] }) {
  const content = cleanText(item.content || item.summary || "", 1200);
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
      evidence_type: item.evidenceType || "federated_public_item",
      metrics: {
        ...(item.metrics || {}),
        federated_canonical_dedupe_url: federatedItemDedupeKey(item),
        federated_search_scan_dedupe_key: federatedItemDedupeKey(item),
        ...(attribution.length ? {
          failover_attribution: attribution,
          failover_from_sources: failoverFromSources,
        } : {}),
      },
    },
    comments: Array.isArray(item.comments) ? item.comments : [],
    source_type: "scraper",
    domainControls,
    contentControls,
  });
  return result.inserted ? 1 : 0;
}

function gitLabIssueIidFromUrl(url = "") {
  const match = String(url || "").match(/\/-\/issues\/(\d+)/i);
  return match?.[1] || "";
}

function gitLabIssueReference(item = {}) {
  const issueUrl = cleanText(item.web_url || item.url || "", 800);
  const projectPath = cleanText(item.project_path || "", 240);
  let issueIid = cleanText(item.iid || gitLabIssueIidFromUrl(issueUrl), 80);
  let namespace = "";
  let project = "";
  let path = projectPath;
  try {
    const parsed = new URL(issueUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const dashIndex = segments.indexOf("-");
    const projectSegments = dashIndex >= 0 ? segments.slice(0, dashIndex) : segments.slice(0, -2);
    if (projectSegments.length >= 2) {
      path = path || projectSegments.join("/");
      namespace = projectSegments.slice(0, -1).join("/");
      project = projectSegments[projectSegments.length - 1] || "";
    }
    const issueIndex = segments.findIndex(segment => segment.toLowerCase() === "issues");
    if (issueIndex >= 0) issueIid = issueIid || cleanText(segments[issueIndex + 1] || "", 80);
  } catch {
    // Keep API-provided values.
  }
  if ((!namespace || !project) && path.includes("/")) {
    const parts = path.split("/").filter(Boolean);
    namespace = parts.slice(0, -1).join("/");
    project = parts[parts.length - 1] || "";
  }
  return {
    projectPath: path,
    namespace,
    project,
    issueIid,
    issueUrl,
  };
}

function gitLabIssueSignals({ title = "", content = "", state = "", labels = [], comments = 0, upvotes = 0, downvotes = 0 } = {}) {
  const labelText = Array.isArray(labels) ? labels.map(label => label?.name || label).join(" ") : String(labels || "");
  const source = cleanText(`${title} ${content} ${state} ${labelText}`, 2200).toLowerCase();
  const complaint = /complaint|refund|support|customer service|billing|chargeback|dispute|投诉|投訴|退款|客服|爭議|争议|扣款/.test(source);
  const outage = /outage|incident|downtime|status|postmortem|degradation|bug|regression|故障|宕机|當機|事故|异常|異常|回歸|回归/.test(source);
  const security = /security|vulnerability|cve|exploit|breach|leak|phishing|xss|csrf|rce|资安|資安|安全|漏洞|外洩|泄露|釣魚|钓鱼/.test(source);
  const maintainerResponse = /maintainer|triage|confirmed|acknowledged|repro|workaround|fix pending|patched|修复|修復|確認|确认|復現|复现|已处理|已處理|臨時方案|临时方案/.test(source);
  const escalation = Number(comments || 0) >= 3 || Number(upvotes || 0) >= 5 || /escalation|urgent|critical|blocker|priority|severity|sev[ -]?[0-2]|p[ -]?[0-1]|緊急|紧急|嚴重|严重|高優先|高优先|阻塞/.test(source);
  const closed = /closed|merged|resolved|done|closed|已关闭|已關閉|已解决|已解決/.test(String(state || "").toLowerCase());
  const controversial = Number(downvotes || 0) > 0 && Number(upvotes || 0) > 0;
  const reasons = [];
  if (complaint) reasons.push("complaint-language");
  if (outage) reasons.push("outage-bug-language");
  if (security) reasons.push("security-language");
  if (maintainerResponse) reasons.push("maintainer-response-language");
  if (escalation) reasons.push("escalation-engagement-signal");
  if (closed) reasons.push("closed-state");
  if (controversial) reasons.push("mixed-vote-signal");
  const semanticSignals = [
    complaint,
    outage || security,
    maintainerResponse,
    escalation || controversial,
    closed || controversial,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  if (completeNarrative) reasons.push("gitlab-complete-community-crisis-narrative");
  return {
    gitlab_complaint_signal: complaint ? 1 : 0,
    gitlab_outage_signal: outage ? 1 : 0,
    gitlab_security_signal: security ? 1 : 0,
    gitlab_maintainer_response_signal: maintainerResponse ? 1 : 0,
    gitlab_escalation_signal: escalation ? 1 : 0,
    gitlab_closed_signal: closed ? 1 : 0,
    gitlab_controversial_signal: controversial ? 1 : 0,
    gitlab_community_semantic_signal_count: semanticSignals,
    gitlab_complete_community_crisis_narrative_signal: completeNarrative ? 1 : 0,
    gitlab_signal_count: reasons.length,
    gitlab_signal_reasons: reasons,
  };
}

function discourseTopicReference(topic = {}, siteUrl = "") {
  const normalizedSite = normalizeSiteUrl(siteUrl);
  const topicId = cleanText(topic.id || topic.topic_id || "", 80);
  const slug = cleanText(topic.slug || "", 200);
  const rawUrl = cleanText(topic.url || "", 800);
  let url = "";
  if (rawUrl) {
    url = rawUrl.startsWith("http")
      ? rawUrl
      : `${normalizedSite}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
  } else if (normalizedSite && slug && topicId) {
    url = `${normalizedSite}/t/${slug}/${topicId}`;
  }
  return {
    site: normalizedSite,
    topicId,
    slug,
    topicUrl: url,
    topicJsonUrl: normalizedSite && slug && topicId ? `${normalizedSite}/t/${slug}/${topicId}.json` : "",
  };
}

function discourseTopicSignals({ title = "", content = "", category = "", posts = 0, views = 0, likes = 0, closed = false, archived = false } = {}) {
  const source = cleanText(`${title} ${content} ${category}`, 2200).toLowerCase();
  const complaint = /complaint|refund|support|customer service|billing|chargeback|dispute|投诉|投訴|退款|客服|爭議|争议|扣款/.test(source);
  const outage = /outage|incident|downtime|status|postmortem|degradation|bug|regression|故障|宕机|當機|事故|异常|異常|回歸|回归/.test(source);
  const security = /security|vulnerability|cve|exploit|breach|leak|phishing|privacy|xss|csrf|rce|资安|資安|安全|漏洞|外洩|泄露|隱私|隐私|釣魚|钓鱼/.test(source);
  const response = /staff|moderator|admin|official|support replied|answered|resolved|workaround|fix|patched|官方|客服回應|客服回应|版主|管理員|管理员|已回覆|已回复|修复|修復|臨時方案|临时方案/.test(source);
  const escalation = Number(posts || 0) >= 5 || Number(views || 0) >= 100 || Number(likes || 0) >= 5 || /escalation|urgent|critical|blocker|priority|severity|sev[ -]?[0-2]|p[ -]?[0-1]|緊急|紧急|嚴重|严重|高優先|高优先|阻塞/.test(source);
  const locked = closed === true || archived === true;
  const reasons = [];
  if (complaint) reasons.push("complaint-language");
  if (outage) reasons.push("outage-incident-language");
  if (security) reasons.push("security-privacy-language");
  if (response) reasons.push("response-resolution-language");
  if (escalation) reasons.push("escalation-engagement-signal");
  if (locked) reasons.push("closed-archived-state");
  const semanticSignals = [
    complaint,
    outage || security,
    response,
    escalation,
    locked || response,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  if (completeNarrative) reasons.push("discourse-complete-community-crisis-narrative");
  return {
    discourse_complaint_signal: complaint ? 1 : 0,
    discourse_outage_signal: outage ? 1 : 0,
    discourse_security_signal: security ? 1 : 0,
    discourse_response_signal: response ? 1 : 0,
    discourse_escalation_signal: escalation ? 1 : 0,
    discourse_locked_signal: locked ? 1 : 0,
    discourse_community_semantic_signal_count: semanticSignals,
    discourse_complete_community_crisis_narrative_signal: completeNarrative ? 1 : 0,
    discourse_signal_count: reasons.length,
    discourse_signal_reasons: reasons,
  };
}

function hostnameFromUrl(value = "") {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function lemmyPostSignals({ title = "", content = "", community = "", score = 0, comments = 0, upvotes = 0, downvotes = 0, saved = 0, local = true, nsfw = false, instanceUrl = "", activitypubId = "", communityActorId = "" } = {}) {
  const source = cleanText(`${title} ${content} ${community}`, 2200).toLowerCase();
  const complaint = /complaint|refund|support|customer service|billing|chargeback|dispute|投诉|投訴|退款|客服|爭議|争议|扣款/.test(source);
  const outage = /outage|incident|downtime|status|postmortem|degradation|bug|regression|故障|宕机|當機|事故|异常|異常|回歸|回归/.test(source);
  const security = /security|vulnerability|cve|exploit|breach|leak|phishing|privacy|xss|csrf|rce|资安|資安|安全|漏洞|外洩|泄露|隱私|隐私|釣魚|钓鱼/.test(source);
  const escalation = Number(comments || 0) >= 3 || Number(score || 0) >= 10 || Number(upvotes || 0) >= 10 || /escalation|urgent|critical|boycott|viral|spreading|amplified|緊急|紧急|嚴重|严重|抵制|擴散|扩散|轉貼|转贴/.test(source);
  const controversial = Number(upvotes || 0) > 0 && Number(downvotes || 0) > 0;
  const instanceHost = hostnameFromUrl(instanceUrl);
  const apHost = hostnameFromUrl(activitypubId);
  const communityHost = hostnameFromUrl(communityActorId);
  const crossInstance = local === false || (apHost && instanceHost && apHost !== instanceHost) || (communityHost && instanceHost && communityHost !== instanceHost);
  const savedSignal = Number(saved || 0) > 0;
  const reasons = [];
  if (complaint) reasons.push("complaint-language");
  if (outage) reasons.push("outage-incident-language");
  if (security) reasons.push("security-privacy-language");
  if (escalation) reasons.push("escalation-engagement-signal");
  if (controversial) reasons.push("mixed-vote-signal");
  if (crossInstance) reasons.push("cross-instance-spread");
  if (savedSignal) reasons.push("saved-bookmark-signal");
  if (nsfw === true) reasons.push("sensitive-content-flag");
  const semanticSignals = [
    complaint,
    outage || security,
    escalation,
    controversial || crossInstance,
    savedSignal || nsfw === true,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  if (completeNarrative) reasons.push("lemmy-complete-community-crisis-narrative");
  return {
    lemmy_complaint_signal: complaint ? 1 : 0,
    lemmy_outage_signal: outage ? 1 : 0,
    lemmy_security_signal: security ? 1 : 0,
    lemmy_escalation_signal: escalation ? 1 : 0,
    lemmy_controversial_signal: controversial ? 1 : 0,
    lemmy_cross_instance_signal: crossInstance ? 1 : 0,
    lemmy_saved_signal: savedSignal ? 1 : 0,
    lemmy_sensitive_signal: nsfw === true ? 1 : 0,
    lemmy_community_semantic_signal_count: semanticSignals,
    lemmy_complete_community_crisis_narrative_signal: completeNarrative ? 1 : 0,
    lemmy_signal_count: reasons.length,
    lemmy_signal_reasons: reasons,
  };
}

function parseGitLabNotes(payload, limit = MAX_FEDERATED_COMMENTS, keyword = "") {
  const notes = Array.isArray(payload) ? payload : [];
  return notes.map(note => {
    const content = cleanText(note.body || "", 1200);
    const noteId = cleanText(note.id || "", 160);
    return withFederatedCommentKeywordDiagnostics({
      external_id: noteId,
      author: cleanText(note.author?.username || note.author?.name || "GitLab", 160),
      content,
      published_at: normalizeIsoDate(note.updated_at || note.created_at),
      metrics: {
        source: "gitlab_note",
        gitlab_note_id: noteId,
        system: note.system === true,
        gitlab_note_system: note.system === true ? 1 : 0,
      },
    }, keyword);
  }).filter(note => note.content).slice(0, limit);
}

function parseDiscourseTopicPosts(payload, limit = MAX_FEDERATED_COMMENTS, keyword = "") {
  const posts = Array.isArray(payload?.post_stream?.posts) ? payload.post_stream.posts : [];
  return posts.slice(1).map(post => {
    const content = cleanText(post.cooked || post.blurb || "", 1200);
    return withFederatedCommentKeywordDiagnostics({
      external_id: cleanText(post.id || "", 160),
      author: cleanText(post.username || "Discourse", 160),
      content,
      published_at: normalizeIsoDate(post.updated_at || post.created_at),
      metrics: {
        source: "discourse_post",
        discourse_post_id: cleanText(post.id || "", 160),
        post_number: Number(post.post_number || 0),
        discourse_post_number: Number(post.post_number || 0),
        like_count: Number(post.like_count || 0),
        discourse_like_count: Number(post.like_count || 0),
      },
    }, keyword);
  }).filter(post => post.content).slice(0, limit);
}

function parseLemmyComments(payload, limit = MAX_FEDERATED_COMMENTS, keyword = "") {
  const comments = Array.isArray(payload?.comments) ? payload.comments : [];
  return comments.map(view => {
    const comment = view?.comment || {};
    const creator = view?.creator || {};
    const counts = view?.counts || {};
    const content = cleanText(comment.content || "", 1200);
    return withFederatedCommentKeywordDiagnostics({
      external_id: cleanText(comment.ap_id || comment.id || "", 300),
      author: cleanText(creator.display_name || creator.name || "Lemmy", 160),
      content,
      published_at: normalizeIsoDate(comment.updated || comment.published),
      metrics: {
        source: "lemmy_comment",
        lemmy_comment_id: cleanText(comment.id || "", 160),
        lemmy_comment_activitypub_id: cleanText(comment.ap_id || "", 500),
        score: Number(counts.score || 0),
        lemmy_comment_score: Number(counts.score || 0),
        upvotes: Number(counts.upvotes || 0),
        lemmy_comment_upvotes: Number(counts.upvotes || 0),
        downvotes: Number(counts.downvotes || 0),
        lemmy_comment_downvotes: Number(counts.downvotes || 0),
        child_count: Number(counts.child_count || 0),
        lemmy_comment_child_count: Number(counts.child_count || 0),
      },
    }, keyword);
  }).filter(comment => comment.content).slice(0, limit);
}

async function fetchGitLabIssueNotes(item, { proxyUrl = "", maxComments = MAX_FEDERATED_COMMENTS, keyword = "" } = {}) {
  const limit = Math.max(0, Math.min(MAX_FEDERATED_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.notesUrl || Number(item?.metrics?.comments || 0) <= 0) return [];
  try {
    const url = `${item.notesUrl}${item.notesUrl.includes("?") ? "&" : "?"}per_page=${limit}&sort=desc&order_by=updated_at`;
    const res = await fetchPublicSource(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseGitLabNotes(await res.json(), limit, keyword);
  } catch {
    return [];
  }
}

async function fetchDiscourseTopicPosts(item, { proxyUrl = "", maxComments = MAX_FEDERATED_COMMENTS, keyword = "" } = {}) {
  const limit = Math.max(0, Math.min(MAX_FEDERATED_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.topicJsonUrl || Number(item?.metrics?.posts || 0) <= 1) return [];
  try {
    const res = await fetchPublicSource(item.topicJsonUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseDiscourseTopicPosts(await res.json(), limit, keyword);
  } catch {
    return [];
  }
}

async function fetchLemmyPostComments(item, { proxyUrl = "", maxComments = MAX_FEDERATED_COMMENTS, keyword = "" } = {}) {
  const limit = Math.max(0, Math.min(MAX_FEDERATED_COMMENTS, Number(maxComments || 0)));
  if (!limit || !item?.commentsUrl || Number(item?.metrics?.comments || 0) <= 0) return [];
  try {
    const res = await fetchPublicSource(`${item.commentsUrl}&limit=${limit}`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) return [];
    return parseLemmyComments(await res.json(), limit, keyword);
  } catch {
    return [];
  }
}

function parseGitLabIssues(payload, keyword, limit = 10, since = "") {
  const items = Array.isArray(payload) ? payload : [];
  return items.map(item => {
    const title = cleanText(item.title || "", 300);
    const content = cleanText(item.description || item.state || "", 1200);
    const reference = gitLabIssueReference(item);
    const projectPath = cleanText(reference.projectPath || item.project_id || "", 200);
    const projectId = cleanText(item.project_id || "", 80);
    const issueIid = reference.issueIid;
    const labels = Array.isArray(item.labels) ? item.labels : [];
    const comments = Number(item.user_notes_count || 0);
    const upvotes = Number(item.upvotes || 0);
    const downvotes = Number(item.downvotes || 0);
    const signals = gitLabIssueSignals({
      title,
      content,
      state: item.state || "",
      labels,
      comments,
      upvotes,
      downvotes,
    });
    return withFederatedKeywordDiagnostics({
      url: cleanText(item.web_url || "", 800),
      title,
      content: content || projectPath,
      author: cleanText(item.author?.name || item.author?.username || "GitLab", 160),
      publishedAt: normalizeIsoDate(item.updated_at || item.created_at),
      notesUrl: projectId && issueIid ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueIid)}/notes` : "",
      evidenceType: "gitlab_issue",
      metrics: {
        source_family: "community",
        source_kind: "federated_issue_tracker",
        collection_mode: "gitlab_public_search_api",
        source_weight_tier: "federated-community",
        project_id: projectId,
        issue_iid: issueIid,
        project_path: projectPath,
        gitlab_project_id: projectId,
        gitlab_project_path: projectPath,
        gitlab_namespace: reference.namespace,
        gitlab_project_name: reference.project,
        gitlab_issue_iid: issueIid,
        gitlab_issue_url: reference.issueUrl,
        state: item.state || "",
        gitlab_issue_state: item.state || "",
        upvotes,
        downvotes,
        comments,
        gitlab_upvotes: upvotes,
        gitlab_downvotes: downvotes,
        gitlab_comment_count: comments,
        gitlab_labels: labels.map(label => cleanText(label?.name || label, 120)).filter(Boolean).join(","),
        gitlab_engagement_score: comments * 2 + upvotes - downvotes,
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseDiscourseSearch(payload, keyword, { siteUrl = "", siteTarget = null, limit = 10, since = "" } = {}) {
  const normalizedSite = normalizeSiteUrl(siteUrl);
  const target = siteTarget && typeof siteTarget === "object" ? siteTarget : {};
  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  const posts = new Map((Array.isArray(payload?.posts) ? payload.posts : []).map(post => [post.topic_id, post]));
  return topics.map(topic => {
    const post = posts.get(topic.id) || {};
    const title = cleanText(topic.title || topic.fancy_title || "", 300);
    const content = cleanText(post.blurb || topic.excerpt || topic.category_name || "", 1200);
    const reference = discourseTopicReference(topic, normalizedSite);
    const postsCount = Number(topic.posts_count || 0);
    const views = Number(topic.views || 0);
    const likes = Number(topic.like_count || 0);
    const signals = discourseTopicSignals({
      title,
      content,
      category: topic.category_name || "",
      posts: postsCount,
      views,
      likes,
      closed: topic.closed === true,
      archived: topic.archived === true,
    });
    return withFederatedKeywordDiagnostics({
      url: cleanText(reference.topicUrl, 800),
      title,
      content,
      author: cleanText(post.username || topic.last_poster_username || "Discourse", 160),
      publishedAt: normalizeIsoDate(topic.bumped_at || topic.created_at || post.created_at),
      topicJsonUrl: reference.topicJsonUrl,
      evidenceType: "discourse_topic",
      metrics: {
        site: normalizedSite,
        site_key: cleanText(target.key || "", 80),
        site_name: cleanText(target.name || "", 160),
        target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
        source_weight_tier: target.tier || "product-community",
        source_family: "community",
        source_kind: "product_forum_discussion",
        collection_mode: "discourse_public_search_api",
        topic_id: reference.topicId,
        discourse_site: reference.site,
        discourse_topic_id: reference.topicId,
        discourse_topic_slug: reference.slug,
        discourse_topic_url: reference.topicUrl,
        discourse_posts_count: postsCount,
        discourse_views: views,
        discourse_like_count: likes,
        discourse_engagement_score: postsCount * 2 + Math.floor(views / 25) + likes * 3,
        discourse_closed: topic.closed === true ? 1 : 0,
        discourse_archived: topic.archived === true ? 1 : 0,
        posts: postsCount,
        views,
        like_count: likes,
        category_id: cleanText(topic.category_id || "", 80),
        discourse_category_id: cleanText(topic.category_id || "", 80),
        discourse_category_name: cleanText(topic.category_name || "", 160),
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

function parseLemmySearch(payload, keyword, { instanceUrl = "", limit = 10, since = "" } = {}) {
  const normalizedInstance = normalizeSiteUrl(instanceUrl);
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  return posts.map(view => {
    const post = view?.post || {};
    const creator = view?.creator || {};
    const community = view?.community || {};
    const counts = view?.counts || {};
    const title = cleanText(post.name || "", 300);
    const content = cleanText(post.body || post.url || community.title || community.name || "", 1200);
    const postId = cleanText(post.id || "", 80);
    const apId = cleanText(post.ap_id || "", 800);
    const comments = Number(counts.comments || 0);
    const score = Number(counts.score || 0);
    const upvotes = Number(counts.upvotes || 0);
    const downvotes = Number(counts.downvotes || 0);
    const saved = Number(counts.saved_count || 0);
    const url = apId.startsWith("http")
      ? apId
      : normalizedInstance && postId
        ? `${normalizedInstance}/post/${encodeURIComponent(postId)}`
        : cleanText(post.url || "", 800);
    const communityName = cleanText(community.name || "", 160);
    const communityTitle = cleanText(community.title || "", 240);
    const communityActorId = cleanText(community.actor_id || "", 500);
    const signals = lemmyPostSignals({
      title,
      content,
      community: `${communityName} ${communityTitle}`,
      score,
      comments,
      upvotes,
      downvotes,
      saved,
      local: post.local === true,
      nsfw: post.nsfw === true,
      instanceUrl: normalizedInstance,
      activitypubId: apId,
      communityActorId,
    });
    return withFederatedKeywordDiagnostics({
      url,
      title,
      content,
      author: cleanText(creator.display_name || creator.name || "Lemmy", 160),
      publishedAt: normalizeIsoDate(post.updated || post.published),
      commentsUrl: normalizedInstance && postId ? `${normalizedInstance}/api/v3/comment/list?post_id=${encodeURIComponent(postId)}&sort=Hot` : "",
      evidenceType: "lemmy_post",
      metrics: {
        source_family: "community",
        source_kind: "federated_discussion",
        collection_mode: "lemmy_public_search_api",
        source_weight_tier: "federated-community",
        instance: normalizedInstance,
        post_id: postId,
        activitypub_id: apId,
        community: communityName,
        community_title: communityTitle,
        community_actor_id: communityActorId,
        lemmy_instance: normalizedInstance,
        lemmy_post_id: postId,
        lemmy_activitypub_id: apId,
        lemmy_post_url: url,
        lemmy_community: communityName,
        lemmy_community_title: communityTitle,
        lemmy_community_actor_id: communityActorId,
        score,
        upvotes,
        downvotes,
        comments,
        saved_count: saved,
        lemmy_score: score,
        lemmy_upvotes: upvotes,
        lemmy_downvotes: downvotes,
        lemmy_comment_count: comments,
        lemmy_saved_count: saved,
        lemmy_engagement_score: score + comments * 2 + upvotes - downvotes + saved * 2,
        nsfw: post.nsfw === true,
        local: post.local === true,
        lemmy_nsfw: post.nsfw === true ? 1 : 0,
        lemmy_local: post.local === true ? 1 : 0,
        ...signals,
      },
    }, keyword);
  }).filter(item => item.url && item.title && textMatchesKeyword(item, keyword) && isAfterSince(item.publishedAt, since)).slice(0, limit);
}

export async function scrapeGitLabIssues(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", domainControls = {}, contentControls = {}, projects = [], projectIds = [], project_ids = [], failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const targets = gitLabIssueSearchTargets(projects?.length ? projects : [...(projectIds || []), ...(project_ids || [])]);
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
          scope: "issues",
          search: keyword,
          per_page: String(Math.min(50, normalizedBudget.maxItemsPerKeyword)),
          page: String(page),
        });
        const url = target.project
          ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(target.project)}/search?${params.toString()}`
          : `https://gitlab.com/api/v4/search?${params.toString()}`;
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
        const rawItems = Array.isArray(payload) ? payload : [];
        const items = parseGitLabIssues(payload, keyword, normalizedBudget.maxItemsPerKeyword - inserted, since);
        if (!items.length && !rawItems.length) break;
        for (const item of items) {
          const dedupeKey = federatedItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchGitLabIssueNotes(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem, keyword });
          inserted += insertFederatedItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              search_scope: target.project ? "project" : "global",
              search_project: target.project || "",
              federated_search_page: page,
              federated_search_raw_result_count: rawItems.length,
            },
          }, { platform: "gitlab_issues", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, message });
      console.warn(`[CRM/GitLabIssues] 抓取失敗 keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeDiscourseForums(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", sites = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const discourseSites = normalizeDiscourseSiteTargets(sites, targetProfiles);
  const seenItemUrls = new Set();

  const tasks = [];
  for (const siteTarget of discourseSites) {
    for (const keyword of normalizedKeywords) tasks.push({ siteTarget, keyword });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ siteTarget, keyword }) => {
    let inserted = 0;
    const failures = [];
    const siteUrl = siteTarget.url;
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const url = `${siteUrl}/search.json?q=${encodeURIComponent(keyword)}&page=${page}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${siteUrl}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawTopics = Array.isArray(payload?.topics) ? payload.topics : [];
        const rawPosts = Array.isArray(payload?.posts) ? payload.posts : [];
        const rawResultCount = Math.max(rawTopics.length, rawPosts.length);
        const items = parseDiscourseSearch(payload, keyword, {
          siteUrl,
          siteTarget,
          limit: normalizedBudget.maxItemsPerKeyword - inserted,
          since,
        });
        if (!items.length && !rawTopics.length && !rawPosts.length) break;
        for (const item of items) {
          const dedupeKey = federatedItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchDiscourseTopicPosts(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem, keyword });
          inserted += insertFederatedItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              federated_search_page: page,
              federated_search_raw_result_count: rawResultCount,
            },
          }, { platform: "discourse", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: siteUrl, message });
      console.warn(`[CRM/Discourse] 抓取失敗 site=${siteUrl} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export async function scrapeLemmySearch(keywords, { proxyUrl = "", budget = {}, deepBudget = null, since = "", instances = [], domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedDeepBudget = normalizeDeepBudget(deepBudget);
  const lemmyInstances = normalizeLemmyInstances(instances);
  const seenItemUrls = new Set();

  const tasks = [];
  for (const instanceUrl of lemmyInstances) {
    for (const keyword of normalizedKeywords) tasks.push({ instanceUrl, keyword });
  }

  const results = await mapWithConcurrency(tasks, KEYWORD_CONCURRENCY, async ({ instanceUrl, keyword }) => {
    let inserted = 0;
    const failures = [];
    try {
      for (let page = 1; page <= normalizedBudget.maxPagesPerKeyword && inserted < normalizedBudget.maxItemsPerKeyword; page += 1) {
        const params = new URLSearchParams({
          q: keyword,
          type_: "Posts",
          sort: "New",
          listing_type: "All",
          page: String(page),
          limit: String(Math.min(50, normalizedBudget.maxItemsPerKeyword)),
        });
        const url = `${instanceUrl}/api/v3/search?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: `${instanceUrl}:page:${page}`, message: httpFailure(res) });
          break;
        }
        const payload = await res.json();
        const rawPosts = Array.isArray(payload?.posts) ? payload.posts : [];
        const items = parseLemmySearch(payload, keyword, {
          instanceUrl,
          limit: normalizedBudget.maxItemsPerKeyword - inserted,
          since,
        });
        if (!items.length && !rawPosts.length) break;
        for (const item of items) {
          const dedupeKey = federatedItemDedupeKey(item);
          if (!dedupeKey || seenItemUrls.has(dedupeKey)) continue;
          seenItemUrls.add(dedupeKey);
          const comments = await fetchLemmyPostComments(item, { proxyUrl, maxComments: normalizedDeepBudget.maxCommentsPerItem, keyword });
          inserted += insertFederatedItem({
            ...item,
            comments,
            metrics: {
              ...(item.metrics || {}),
              federated_search_page: page,
              federated_search_raw_result_count: rawPosts.length,
            },
          }, { platform: "lemmy", keyword, domainControls, contentControls, failoverAttribution });
          if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
        }
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: instanceUrl, message });
      console.warn(`[CRM/Lemmy] 抓取失敗 instance=${instanceUrl} keyword=${keyword}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  DISCOURSE_FORUM_TARGETS,
  DEFAULT_DISCOURSE_SITES,
  DEFAULT_LEMMY_INSTANCES,
  normalizeBudget,
  normalizeFederatedDedupeUrl,
  federatedItemDedupeKey,
  normalizeFederatedKeywordText,
  federatedKeywordNeedles,
  federatedValueMatchesKeyword,
  textMatchesKeyword,
  federatedKeywordMatchSource,
  federatedCommentKeywordMatchSource,
  withFederatedKeywordDiagnostics,
  withFederatedCommentKeywordDiagnostics,
  normalizeDiscourseSiteTargets,
  normalizeDiscourseSites,
  normalizeLemmyInstances,
  normalizeGitLabProjects,
  gitLabIssueSearchTargets,
  gitLabIssueReference,
  gitLabIssueSignals,
  discourseTopicReference,
  discourseTopicSignals,
  lemmyPostSignals,
  parseGitLabIssues,
  parseGitLabNotes,
  parseDiscourseSearch,
  parseDiscourseTopicPosts,
  parseLemmySearch,
  parseLemmyComments,
  normalizeDeepBudget,
};
