import { scrapeRssFeeds, PUBLIC_RSS_FEED_PACKS } from "./rss-feeds.js";

export const OFFICIAL_REGULATORY_FEED_PACKS = ["consumerProtection", "taiwanRegulatory", "regulatoryNotices"];

export function listOfficialRegulatoryFeeds() {
  return OFFICIAL_REGULATORY_FEED_PACKS.flatMap(pack => (
    PUBLIC_RSS_FEED_PACKS[pack] || []
  ).map(feed => ({
    ...feed,
    pack,
    sourceKey: "officialRegulatory",
    sourceFamily: feed.sourceFamily || "regulatory",
    regulatory: true,
  })));
}

function normalizeRegulatoryText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function regulatoryTermMatches(text = "", terms = [], limit = 12) {
  const normalized = normalizeRegulatoryText(text);
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    const needle = normalizeRegulatoryText(raw);
    if (needle && normalized.includes(needle) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

export function officialRegulatoryNarrativeSignals({ item = {}, feed = {}, feedMeta = {}, metrics = {} } = {}) {
  const feedTags = Array.isArray(feed.tags) ? feed.tags : [];
  const categories = Array.isArray(item.categories) ? item.categories : [];
  const text = [
    item.title,
    item.content,
    item.author,
    item.url,
    feed.name,
    feed.url,
    feed.pack,
    feed.sourceFamily,
    feedMeta.feed_title,
    ...(Array.isArray(metrics.feed_tags) ? metrics.feed_tags : feedTags),
    ...(Array.isArray(metrics.feed_item_categories) ? metrics.feed_item_categories : categories),
  ].filter(Boolean).join(" ");
  const authorityTerms = regulatoryTermMatches(text, [
    "official", "regulator", "regulatory", "agency", "commission", "authority", "consumer protection", "fda", "ftc", "cpsc", "sec", "hkma",
    "官方", "监管", "監管", "主管机关", "主管機關", "消保", "消费者保护", "消費者保護",
  ]);
  const actionTerms = regulatoryTermMatches(text, [
    "warning", "alert", "recall", "safety alert", "enforcement", "litigation", "administrative proceeding", "trading suspension",
    "investigation", "review", "notice", "press release", "circular", "guideline", "outbreak",
    "警告", "预警", "預警", "召回", "安全警示", "执法", "執法", "调查", "調查", "审查", "審查", "公告", "通告", "指引",
  ]);
  const impactTerms = regulatoryTermMatches(text, [
    "refund", "complaint", "consumer", "customer", "privacy", "data", "fraud", "scam", "safety", "health", "injury", "outbreak",
    "product safety", "financial", "banking", "competition", "market", "cybersecurity",
    "退款", "投诉", "投訴", "消费者", "消費者", "用户", "用戶", "隐私", "隱私", "数据", "資料", "诈骗", "詐騙", "安全", "健康", "金融",
  ]);
  const remedyTerms = regulatoryTermMatches(text, [
    "corrective action", "remediation", "remedy", "recall", "refund", "consumer protection review", "settlement", "order", "cease", "ban",
    "fine", "penalty", "compliance", "guidance", "advisory", "under investigation",
    "整改", "补救", "補救", "召回", "退款", "和解", "命令", "罚款", "罰款", "合规", "合規", "处置", "處置", "调查中", "調查中",
  ]);
  const evidenceTerms = regulatoryTermMatches(text, [
    "evidence", "notice", "release", "report", "filing", "record", "case", "docket", "letter", "feed", "rss", "public", "official warning",
    "证据", "證據", "公告", "通报", "通報", "报告", "報告", "记录", "紀錄", "案件", "公开", "公開", "官方警告",
  ]);
  const sourceTier = String(metrics.source_weight_tier || "").toLowerCase();
  const authoritySignal = authorityTerms.length || feed.regulatory || feed.sourceFamily === "regulatory" || feed.sourceFamily === "consumer_protection" || sourceTier.includes("regulatory");
  const reasons = [];
  if (authoritySignal) reasons.push("official-regulatory-authority-source");
  if (actionTerms.length) reasons.push("official-regulatory-action-language");
  if (impactTerms.length) reasons.push("official-regulatory-impact-language");
  if (remedyTerms.length) reasons.push("official-regulatory-remedy-language");
  if (evidenceTerms.length) reasons.push("official-regulatory-evidence-language");
  const semanticSignals = [
    authoritySignal,
    actionTerms.length,
    impactTerms.length,
    remedyTerms.length,
    evidenceTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignals >= 5;
  if (completeNarrative) reasons.push("official-regulatory-complete-event-narrative");
  return {
    official_regulatory_authority_signal: authoritySignal ? 1 : 0,
    official_regulatory_action_signal: actionTerms.length ? 1 : 0,
    official_regulatory_impact_scope_signal: impactTerms.length ? 1 : 0,
    official_regulatory_remedy_signal: remedyTerms.length ? 1 : 0,
    official_regulatory_evidence_signal: evidenceTerms.length ? 1 : 0,
    official_regulatory_semantic_signal_count: semanticSignals,
    official_regulatory_complete_event_narrative_signal: completeNarrative ? 1 : 0,
    official_regulatory_authority_terms: authorityTerms,
    official_regulatory_action_terms: actionTerms,
    official_regulatory_impact_terms: impactTerms,
    official_regulatory_remedy_terms: remedyTerms,
    official_regulatory_evidence_terms: evidenceTerms,
    official_regulatory_narrative_reasons: reasons,
  };
}

export async function scrapeOfficialRegulatorySources(keywords, {
  proxyUrl = "",
  enrich = true,
  budget = {},
  since = "",
  cursor = {},
  conditionalRequests = true,
  feeds = [],
  feedPacks = OFFICIAL_REGULATORY_FEED_PACKS,
  domainControls = {},
  contentControls = {},
  failoverAttribution = [],
  directUrls = [],
} = {}) {
  const configuredFeeds = Array.isArray(feeds) && feeds.length
    ? feeds.map(feed => ({
      ...(typeof feed === "string" ? { url: feed, name: feed } : feed),
      sourceKey: "officialRegulatory",
      regulatory: true,
      requireTaiwan: feed?.requireTaiwan === true,
    }))
    : listOfficialRegulatoryFeeds();
  const configuredPacks = Array.isArray(feedPacks) && feedPacks.length ? feedPacks : OFFICIAL_REGULATORY_FEED_PACKS;
  return scrapeRssFeeds(keywords, {
    proxyUrl,
    enrich,
    budget,
    since,
    cursor,
    conditionalRequests,
    feeds: configuredFeeds,
    feedPacks: configuredFeeds.length ? [] : configuredPacks,
    domainControls,
    contentControls,
    failoverAttribution,
    metricsEnhancer: officialRegulatoryNarrativeSignals,
    directUrls,
  });
}

export const __test__ = {
  OFFICIAL_REGULATORY_FEED_PACKS,
  listOfficialRegulatoryFeeds,
  officialRegulatoryNarrativeSignals,
};
