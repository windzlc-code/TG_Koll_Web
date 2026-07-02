/**
 * routes/sentiment.js — 輿情 REST API
 * plugin-manager 格式：export default Hono app
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../db/db.js";
import { getTaiwanRecentWhereClause } from "../scrapers/filters.js";
import { listPublicRssFeedPacks } from "../scrapers/rss-feeds.js";
import {
  acknowledgeSentimentAlert,
  answerSentimentQuestion,
  answerSentimentQuestionWithAi,
  applySentimentSourceQualityTuning,
  applySentimentSourceAutoGovernancePolicy,
  buildSentimentSpreadGraph,
  buildSentimentCsv,
  buildSentimentReportMarkdownWithAi,
  compareSentimentTopics,
  createSentimentAlertAction,
  createSentimentReportSchedule,
  deleteSentimentReportSchedule,
  dispatchSentimentAlertNotifications,
  generateCrisisBrief,
  generateCrisisBriefWithAi,
  buildSentimentMigrationJsonl,
  getSentimentDashboard,
  getSentimentArchitectureStatus,
  getSentimentCommercialRemediationPlan,
  getSentimentCommercialRemediationEffectivenessReport,
  getSentimentCommercialRemediationPostScanEvaluation,
  getSentimentCommercialPolicyGovernanceReport,
  getSentimentCommercialReadinessReport,
  getSentimentEventClusterAnalysisReport,
  getSentimentEventClusterFollowupEffectivenessReport,
  getSentimentEvidenceCoverageFollowupRecoveryReport,
  getSentimentEvidenceCoverageRoutedAlternateEffectivenessReport,
  getSentimentFreeSourceTargetCoverageEffectivenessReport,
  getSentimentInsightSummary,
  getSentimentKeywordSourceFamilyCoverageEffectivenessReport,
  getSentimentMultilingualQueryEffectivenessReport,
  getSentimentRealtimeDiscoveryLatencyReport,
  listSentimentRealtimeHotTopics,
  listSentimentRealtimeAnomalyWindows,
  listSentimentKeywordSourceFamilyCoverage,
  getSentimentTrendSummary,
  insertSentimentItems,
  applySentimentEntityRecallPolicy,
  applySentimentDomainQualityPolicy,
  applySentimentEvidenceCoverageFollowupJobs,
  applySentimentPostScanEvidenceFollowupJobs,
  applySentimentRecoverableFollowupJobs,
  applySentimentRssNativeEntryPromotionCandidates,
  applySentimentRssNativeEntryPromotionGovernancePolicy,
  applySentimentRssNativeEntryPromotionRefreshJobs,
  applySentimentRetryQualityFeedbackPolicy,
  applySentimentRssModeCoverageRecommendations,
  applySentimentCommercialRemediationPolicy,
  applySentimentSourceDiscoveryPolicy,
  applySentimentSocialFollowupPolicy,
  applySentimentSourceReliabilityPolicy,
  applySentimentSourceRecoveryPlaybook,
  executeSentimentSourceDiscoveryDeepCrawlPlan,
  listAccessBarrierAlternateRecoveryEffectiveness,
  listSentimentAlertRules,
  listSentimentAnomalies,
  listSentimentAlertActions,
  listSentimentAuthorReputationProfiles,
  listSentimentComments,
  listSentimentCoordinatedAmplificationSignals,
  listSentimentContentSimilarityClusters,
  listSentimentVolumePrecisionReport,
  listSentimentCollectionJobs,
  listSentimentCollectionJobRetryPlan,
  listSentimentCollectionOperationsRemediationEffectiveness,
  getSentimentRssPrioritySiteGapRecoveryReport,
  getSentimentRssNativeEntryDiscoveryRecoveryReport,
  getSentimentRssSourceFamilyRefreshRecoveryReport,
  getSentimentRssNativeEntryPromotionEffectivenessReport,
  getSentimentRssNativeEntryPromotionGovernanceReport,
  getSentimentRssNativeEntryPromotionRefreshRecoveryReport,
  listSentimentDeepCollectionHealthProfiles,
  listSentimentDomainQualityProfiles,
  listSentimentRetryQualityFeedback,
  planSentimentRecoverableFollowupJobs,
  planSentimentEvidenceCoverageFollowupJobs,
  planSentimentPostScanEvidenceFollowupJobs,
  planSentimentRssNativeEntryPromotionRefreshJobs,
  listSentimentCollectionContributionScores,
  listSentimentMultilingualQueryQuality,
  listSentimentNoiseSuppressionReport,
  listSentimentEvidence,
  listSentimentEvidenceChainGapReport,
  listSentimentEvidenceDepthReport,
  listSentimentInsights,
  listSentimentAlerts,
  listSentimentEntityRecallGaps,
  listSentimentEntityTopicRecallGaps,
  listSentimentEntityTopicSourceRecallGaps,
  listSentimentEntityRecallTrend,
  listSentimentEntityTopicRecallTrend,
  listSentimentEventEdges,
  listSentimentEvents,
  listSentimentFactClaims,
  listCrisisBriefs,
  listSentimentNotifications,
  listSentimentReportSchedules,
  listSentimentScanBatches,
  listSentimentScanSourceLogs,
  listSentimentSourceCoverageScores,
  listSentimentSourceDiscoveryCandidates,
  listSentimentSourceDiscoveryDeepCrawlPlan,
  listSentimentSocialFollowupSignals,
  listSentimentRssNativeEntryPromotionCandidates,
  listSentimentRssFeedPackCoverage,
  getSentimentTaiwanMediaSourceHealthReport,
  getSentimentSourceCredibilityReport,
  listSentimentSourceQualityProfiles,
  listSentimentSourceAutoGovernancePolicy,
  listSentimentSourceReliabilityReport,
  listSentimentSourceRecoveryAudit,
  listSentimentSourceRecoverySummary,
  listSentimentSources,
  listSentimentVisualAssets,
  normalizeSentimentMonitorKeywords,
  processSentimentIntelligence,
  maskSentimentAiSettings,
  maskSentimentOpenSearchSettings,
  readSentimentAiSettings,
  readSentimentNotificationSettings,
  readSentimentSearchSettings,
  reprocessSentimentInsights,
  retrySentimentNotification,
  requeueSentimentCollectionJobs,
  refreshSentimentFactClaims,
  rollbackSentimentSourceRecoveryAudit,
  rebuildSentimentSearchIndex,
  getSentimentSearchIndexHealth,
  getSentimentOpenSearchHealth,
  maintainSentimentOpenSearchArchive,
  searchSentimentEvidence,
  syncSentimentOpenSearchArchive,
  summarizeSentimentFactClaims,
  writeSentimentAiSettings,
  upsertSentimentAlertRule,
  upsertSentimentSource,
  updateSentimentAlertAction,
  updateSentimentAlertStatus,
  updateSentimentEventStatus,
  validateSentimentSourceDiscoveryCandidates,
  writeSentimentNotificationSettings,
  writeSentimentSearchSettings,
} from "../sentiment-store.js";
import {
  getSentimentMonitorStatus,
  getLastSentimentScanResult,
  deriveOfficialRegulatoryFollowupSourceSignals,
  applySentimentFreeSourceTargetCoverageFollowupJobs,
  applySentimentCollectionOperationsRemediation,
  executeSentimentContinuousCollectionCycle,
  executeDueSentimentCollectionJobs,
  getSentimentCollectionOperationsReport,
  getSentimentFreeSourceTargetCoverageReport,
  getSentimentRealtimeSourceCoverageReport,
  planSentimentFreeSourceTargetCoverageFollowupJobs,
  planSentimentCollectionOperationsRemediation,
  planSentimentContinuousCollection,
  listSentimentSourceSchedule,
  listSentimentSourceThrottleState,
  listSentimentQueryTemplatePacks,
  runSentimentScanNow,
  startSentimentScheduler,
  stopSentimentScheduler,
} from "../scrapers/runner.js";

const app = new Hono();

function parseLimit(raw, fallback = 50) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(200, Math.max(1, value));
}

function parseSyncLimit(raw, fallback = 1000) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(10000, Math.max(1, value));
}

function optionalBodyNumber(body = {}, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return body[key];
  }
  return undefined;
}

function optionalBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function parseCsvQuery(raw = "") {
  return String(raw || "").split(",").map(item => item.trim()).filter(Boolean);
}

function parseSourceList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") return parseCsvQuery(value);
  return null;
}

function sourceListInput(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, "sources")) return body.sources;
  if (Object.prototype.hasOwnProperty.call(body, "source_keys")) return body.source_keys;
  if (Object.prototype.hasOwnProperty.call(body, "sourceKeys")) return body.sourceKeys;
  return undefined;
}

function routeScanMode(value = "") {
  const raw = String(value || "fast").trim().toLowerCase();
  if (["full", "deep", "depth"].includes(raw)) return "full";
  if (["watch", "crisis", "warning"].includes(raw)) return "watch";
  return "fast";
}

function configuredSourceScopeForMode(c, mode = "fast") {
  const config = pluginCtx(c).config;
  const settings = typeof config?.get === "function" ? config.get("adminSettings") : null;
  const scopes = settings?.sourceScopes || settings?.source_scopes || {};
  const selected = parseSourceList(scopes[routeScanMode(mode)]);
  return selected?.length ? selected : null;
}

function resolveRouteScanSources(c, body = {}) {
  const mode = routeScanMode(body.mode || body.scanMode || body.scan_mode || "fast");
  const rawSources = sourceListInput(body);
  if (rawSources !== undefined) {
    return { mode, rawSources, sources: parseSourceList(rawSources), sourceScope: "request" };
  }
  const scoped = configuredSourceScopeForMode(c, mode);
  return { mode, rawSources, sources: scoped, sourceScope: scoped?.length ? "admin-settings" : "search-settings" };
}

function resolveRouteQueryScanSources(c, modeValue = "fast") {
  const mode = routeScanMode(modeValue);
  const rawSources = c.req.query("sources") || c.req.query("source_keys") || c.req.query("sourceKeys");
  if (rawSources !== undefined && rawSources !== null && rawSources !== "") {
    return { mode, rawSources, sources: parseSourceList(rawSources), sourceScope: "request" };
  }
  const scoped = configuredSourceScopeForMode(c, mode);
  return { mode, rawSources: undefined, sources: scoped, sourceScope: scoped?.length ? "admin-settings" : "search-settings" };
}

function routeSearchSettingsWithSources(c, sources = null) {
  const base = readSentimentSearchSettings(pluginCtx(c).config);
  if (!Array.isArray(sources) || !sources.length) return base;
  return {
    ...base,
    sources: [...new Set(sources.map(source => String(source || "").trim()).filter(Boolean))],
  };
}

function mergeRecoverableFreeTargetCoveragePlan(base = {}, freeTarget = {}, limit = 30) {
  const safeLimit = parseLimit(limit, 30);
  const unique = new Map();
  for (const job of [...(base.jobs || []), ...(freeTarget.jobs || [])]) {
    if (!job?.jobKey || unique.has(job.jobKey)) continue;
    unique.set(job.jobKey, job);
  }
  const jobs = [...unique.values()]
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.sourceKey || "").localeCompare(String(b.sourceKey || "")))
    .slice(0, safeLimit);
  const freeJobs = jobs.filter(job => job.metadata?.task_type === "free-source-target-coverage");
  return {
    ...base,
    summary: {
      ...(base.summary || {}),
      planned_jobs: jobs.length,
      free_source_target_coverage_jobs: freeJobs.length,
      free_source_target_coverage_source_count: new Set(freeJobs.map(job => job.sourceKey || job.source_key || "")).size,
      free_source_target_coverage_gap_count: Number(freeTarget.summary?.gap_count || freeTarget.coverage_summary?.gap_count || 0) || 0,
      highest_priority: Math.max(0, ...jobs.map(job => Number(job.priority || 0))),
    },
    jobs,
  };
}

function mergeAppliedRecoverableFreeTargetCoverage(base = {}, freeTarget = {}) {
  const jobs = [...(base.jobs || []), ...(freeTarget.jobs || [])];
  const freeJobs = jobs.filter(job => job.metadata?.task_type === "free-source-target-coverage");
  const upsertedFreeJobs = freeJobs.filter(job => job.upsert_action !== "skipped_running");
  const skippedFreeJobs = freeJobs.filter(job => job.upsert_action === "skipped_running" || job.skipped);
  return {
    ...base,
    summary: {
      ...(base.summary || {}),
      planned_jobs: Number(base.summary?.planned_jobs || 0) + Number(freeTarget.summary?.planned_jobs || 0),
      created_jobs: Number(base.summary?.created_jobs || 0) + upsertedFreeJobs.length,
      upserted_jobs: Number(base.summary?.upserted_jobs || base.summary?.created_jobs || 0) + upsertedFreeJobs.length,
      skipped_running_jobs: Number(base.summary?.skipped_running_jobs || 0) + skippedFreeJobs.length,
      free_source_target_coverage_jobs: freeJobs.length,
      free_source_target_coverage_source_count: new Set(freeJobs.map(job => job.sourceKey || job.source_key || "")).size,
      free_source_target_coverage_gap_count: Number(freeTarget.summary?.gap_count || freeTarget.coverage_summary?.gap_count || 0) || 0,
      created_free_source_target_coverage_jobs: upsertedFreeJobs.length,
      skipped_running_free_source_target_coverage_jobs: skippedFreeJobs.length,
      highest_priority: Math.max(0, ...(base.jobs || []).map(job => Number(job.priority || 0)), ...(freeTarget.jobs || []).map(job => Number(job.priority || 0))),
    },
    jobs,
  };
}

function cleanCookieValue(value = "", max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeBrowserAuthCookie(cookie = {}, domain = "") {
  if (!cookie || typeof cookie !== "object") return null;
  const name = cleanCookieValue(cookie.name, 200);
  const value = typeof cookie.value === "string" ? cookie.value.slice(0, 5000) : "";
  if (!name || !value) return null;
  const normalizedDomain = cleanCookieValue(cookie.domain || domain, 240);
  return {
    name,
    value,
    domain: normalizedDomain ? (normalizedDomain.startsWith(".") ? normalizedDomain : `.${normalizedDomain.replace(/^\.+/, "")}`) : undefined,
    path: cleanCookieValue(cookie.path || "/", 240) || "/",
    httpOnly: Boolean(cookie.httpOnly || cookie.http_only),
    secure: cookie.secure !== false,
    sameSite: ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined,
    expires: Number.isFinite(Number(cookie.expires)) ? Number(cookie.expires) : undefined,
  };
}

const BROWSER_AUTH_EXPIRING_SOON_SECONDS = 7 * 24 * 60 * 60;
const BROWSER_AUTH_STALE_SESSION_DAYS = 14;

function browserCookieState(cookies = [], now = new Date(), options = {}) {
  const nowSeconds = now.getTime() / 1000;
  const rows = Array.isArray(cookies) ? cookies : [];
  let validCookieCount = 0;
  let expiredCookieCount = 0;
  let sessionCookieCount = 0;
  let persistentCookieCount = 0;
  let expiringSoonCookieCount = 0;
  let nearestExpires = Infinity;
  const expiredCookieNames = [];
  const expiringSoonCookieNames = [];
  for (const cookie of rows) {
    const expires = Number(cookie?.expires);
    if (!Number.isFinite(expires) || expires <= 0) {
      sessionCookieCount += 1;
      validCookieCount += 1;
      continue;
    }
    if (expires <= nowSeconds) {
      expiredCookieCount += 1;
      if (cookie?.name && expiredCookieNames.length < 20) expiredCookieNames.push(cookie.name);
      continue;
    }
    persistentCookieCount += 1;
    validCookieCount += 1;
    nearestExpires = Math.min(nearestExpires, expires);
    if (expires <= nowSeconds + BROWSER_AUTH_EXPIRING_SOON_SECONDS) {
      expiringSoonCookieCount += 1;
      if (cookie?.name && expiringSoonCookieNames.length < 20) expiringSoonCookieNames.push(cookie.name);
    }
  }
  const lastAuthorizedAt = options?.lastAuthorizedAt || options?.last_authorized_at || "";
  const lastAuthorizedTime = lastAuthorizedAt ? new Date(lastAuthorizedAt).getTime() : NaN;
  const lastAuthorizedAgeDays = Number.isFinite(lastAuthorizedTime)
    ? Math.max(0, Math.round(((now.getTime() - lastAuthorizedTime) / (24 * 60 * 60 * 1000)) * 10) / 10)
    : null;
  const statusReasons = [];
  let authHealth = "healthy";
  let recommendedAction = "keep";
  if (!rows.length) {
    authHealth = "missing";
    recommendedAction = "authorize-profile";
    statusReasons.push("missing-cookies");
  } else if (!validCookieCount) {
    authHealth = "expired";
    recommendedAction = "reauthorize-profile";
    statusReasons.push("all-cookies-expired");
  } else if (expiredCookieCount > 0) {
    authHealth = "degraded";
    recommendedAction = "refresh-profile-cookies";
    statusReasons.push("partial-expired-cookies");
  } else if (expiringSoonCookieCount > 0) {
    authHealth = "watch";
    recommendedAction = "refresh-before-expiry";
    statusReasons.push("cookies-expiring-soon");
  } else if (persistentCookieCount === 0 && sessionCookieCount > 0 && lastAuthorizedAgeDays !== null && lastAuthorizedAgeDays > BROWSER_AUTH_STALE_SESSION_DAYS) {
    authHealth = "watch";
    recommendedAction = "reauthorize-session-profile";
    statusReasons.push("stale-session-cookies");
  }
  return {
    cookieCount: rows.length,
    validCookieCount,
    expiredCookieCount,
    sessionCookieCount,
    persistentCookieCount,
    expiringSoonCookieCount,
    nearestExpiresAt: Number.isFinite(nearestExpires) ? new Date(nearestExpires * 1000).toISOString() : null,
    authStatus: validCookieCount > 0 ? "authorized" : rows.length > 0 ? "expired" : "missing",
    authHealth,
    authorizationExpired: rows.length > 0 && validCookieCount === 0,
    authorizationNeedsRefresh: recommendedAction !== "keep",
    hasExpiredCookies: expiredCookieCount > 0,
    lastAuthorizedAgeDays,
    recommendedAction,
    statusReasons,
    expiredCookieNames: [...new Set(expiredCookieNames)],
    expiringSoonCookieNames: [...new Set(expiringSoonCookieNames)],
  };
}

function activeBrowserAuthCookies(cookies = [], now = new Date()) {
  const nowSeconds = now.getTime() / 1000;
  const byKey = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const expires = Number(cookie?.expires);
    if (Number.isFinite(expires) && expires > 0 && expires <= nowSeconds) continue;
    const key = `${cookie.name || ""}|${cookie.domain || ""}|${cookie.path || ""}`;
    if (!cookie.name || !cookie.value) continue;
    byKey.set(key, cookie);
  }
  return [...byKey.values()];
}

function browserAuthRequestAuthorized(c, settings = {}) {
  const expected = String(settings.browserFallback?.authHelperToken || "").trim();
  const provided = String(c.req.header("x-sentiment-browser-auth") || "").trim();
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function browserAuthProfilesForClient(settings = {}) {
  return (settings.browserFallback?.profiles || []).map(profile => {
    const cookies = Array.isArray(profile.cookies) ? profile.cookies : [];
    const lastAuthorizedAt = profile.lastAuthorizedAt || profile.last_authorized_at || null;
    return {
      key: profile.key,
      label: profile.label,
      aliases: Array.isArray(profile.aliases) ? profile.aliases : [],
      sourceKey: profile.sourceKey,
      platform: profile.platform,
      domain: profile.domain,
      authUrl: profile.authUrl,
      authUrls: profile.authUrls,
      cookieDomains: profile.cookieDomains,
      matchDomains: profile.matchDomains,
      urlTemplate: profile.urlTemplate,
      urlTemplates: profile.urlTemplates,
      ...browserCookieState(cookies, new Date(), { lastAuthorizedAt }),
      cookieNames: cookies.map(cookie => cookie.name).filter(Boolean).slice(0, 80),
      lastAuthorizedAt,
    };
  });
}

function browserAuthProfilesSummaryForClient(profiles = []) {
  const rows = Array.isArray(profiles) ? profiles : [];
  const actionProfiles = rows
    .filter(profile => profile.authorizationNeedsRefresh)
    .map(profile => ({
      key: profile.key,
      label: profile.label,
      domain: profile.domain,
      authHealth: profile.authHealth,
      recommendedAction: profile.recommendedAction,
      statusReasons: Array.isArray(profile.statusReasons) ? profile.statusReasons : [],
      validCookieCount: Number(profile.validCookieCount || 0),
      expiredCookieCount: Number(profile.expiredCookieCount || 0),
    }));
  const nearestExpiresAt = rows
    .map(profile => profile.nearestExpiresAt)
    .filter(Boolean)
    .sort()[0] || null;
  const latestAuthorizedAt = rows
    .map(profile => profile.lastAuthorizedAt)
    .filter(Boolean)
    .sort()
    .pop() || null;
  return {
    profileCount: rows.length,
    authorizedProfileCount: rows.filter(profile => Number(profile.validCookieCount || 0) > 0).length,
    healthyProfileCount: rows.filter(profile => profile.authHealth === "healthy").length,
    needsRefreshProfileCount: actionProfiles.length,
    missingProfileCount: rows.filter(profile => profile.authHealth === "missing").length,
    expiredProfileCount: rows.filter(profile => profile.authHealth === "expired").length,
    degradedProfileCount: rows.filter(profile => profile.authHealth === "degraded").length,
    watchProfileCount: rows.filter(profile => profile.authHealth === "watch").length,
    validCookieCount: rows.reduce((sum, profile) => sum + Number(profile.validCookieCount || 0), 0),
    expiredCookieCount: rows.reduce((sum, profile) => sum + Number(profile.expiredCookieCount || 0), 0),
    expiringSoonCookieCount: rows.reduce((sum, profile) => sum + Number(profile.expiringSoonCookieCount || 0), 0),
    nearestExpiresAt,
    latestAuthorizedAt,
    recommendedActions: [...new Set(actionProfiles.map(profile => profile.recommendedAction).filter(Boolean))],
    actionProfiles,
  };
}

function corsJson(c, payload, status = 200) {
  return c.json(payload, status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
}

function invalidSourceKeys(sources = []) {
  if (!Array.isArray(sources) || !sources.length) return [];
  const known = new Set(listSentimentSources().map(source => source.source_key));
  return sources.filter(source => !known.has(source));
}

function pluginCtx(c) {
  try {
    return c.get("pluginCtx") || {};
  } catch {
    return {};
  }
}

// GET /api/plugins/sentiment/sentiment
app.get("/", (c) => {
  const db = getDb();
  const { recent_only = "" } = c.req.query();
  if (recent_only !== "1") {
    const dashboard = getSentimentDashboard({ limit: parseLimit(c.req.query("limit"), 50) });
    return c.json({ ...dashboard, status: getSentimentMonitorStatus() });
  }

  const { limit = "50", unread_only = "" } = c.req.query();
  const filter = getTaiwanRecentWhereClause();
  let sql = `SELECT * FROM crm_sentiment WHERE ${filter.sql}`;
  const params = [...filter.params];
  if (unread_only === "1") {
    sql += " AND is_read = 0";
  }
  sql += " ORDER BY published_at DESC, found_at DESC LIMIT ?";
  params.push(Math.min(200, Math.max(1, isNaN(parseInt(limit,10)) ? 50 : parseInt(limit,10))));

  const items = db.prepare(sql).all(...params);
  const unreadCount = db.prepare(
    `SELECT COUNT(*) as n FROM crm_sentiment WHERE ${filter.sql} AND is_read = 0`
  ).get(...filter.params).n;
  return c.json({ items, unreadCount });
});

// GET /api/plugins/sentiment/sentiment/dashboard
app.get("/dashboard", (c) => {
  const dashboard = getSentimentDashboard({ limit: parseLimit(c.req.query("limit"), 50) });
  return c.json({ ...dashboard, status: getSentimentMonitorStatus() });
});

// GET /api/plugins/sentiment/sentiment/commercial-readiness
app.get("/commercial-readiness", (c) => c.json(getSentimentCommercialReadinessReport({
  config: pluginCtx(c).config,
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/commercial-remediation-plan
app.get("/commercial-remediation-plan", (c) => c.json(getSentimentCommercialRemediationPlan({
  config: pluginCtx(c).config,
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/commercial-remediation-plan
app.post("/commercial-remediation-plan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentCommercialRemediationPolicy({
    config: pluginCtx(c).config,
    days: body.days || 30,
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    actionNames: body.action_names || body.actionNames || [],
    limit: body.limit || 100,
  }));
});

// GET /api/plugins/sentiment/sentiment/commercial-remediation-effectiveness
app.get("/commercial-remediation-effectiveness", (c) => c.json(getSentimentCommercialRemediationEffectivenessReport({
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  action: c.req.query("action") || "",
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/commercial-remediation-post-scan
app.get("/commercial-remediation-post-scan", (c) => c.json(getSentimentCommercialRemediationPostScanEvaluation({
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  action: c.req.query("action") || "",
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/commercial-policy-governance
app.get("/commercial-policy-governance", (c) => c.json(getSentimentCommercialPolicyGovernanceReport({
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  action: c.req.query("action") || "",
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/realtime-discovery-latency
app.get("/realtime-discovery-latency", (c) => c.json(getSentimentRealtimeDiscoveryLatencyReport({
  config: pluginCtx(c).config,
  days: c.req.query("days") || 7,
  limit: parseLimit(c.req.query("limit"), 300),
})));

// GET /api/plugins/sentiment/sentiment/realtime-source-coverage
app.get("/realtime-source-coverage", (c) => c.json(getSentimentRealtimeSourceCoverageReport({
  lookbackHours: parseLimit(c.req.query("lookback_hours") || c.req.query("lookbackHours"), 6),
  limit: parseLimit(c.req.query("limit"), 30),
  minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 38),
  now: c.req.query("now") || Date.now(),
})));

// GET /api/plugins/sentiment/sentiment/free-source-target-coverage
app.get("/free-source-target-coverage", (c) => c.json(getSentimentFreeSourceTargetCoverageReport({
  searchSettings: readSentimentSearchSettings(),
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/free-source-target-coverage-effectiveness
app.get("/collection-jobs/free-source-target-coverage-effectiveness", (c) => c.json(getSentimentFreeSourceTargetCoverageEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/free-source-target-coverage-followups
app.get("/collection-jobs/free-source-target-coverage-followups", (c) => c.json(planSentimentFreeSourceTargetCoverageFollowupJobs({
  searchSettings: readSentimentSearchSettings(),
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
  limit: parseLimit(c.req.query("limit"), 30),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/free-source-target-coverage-followups
app.post("/collection-jobs/free-source-target-coverage-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentFreeSourceTargetCoverageFollowupJobs({
    apply: body.apply === true,
    searchSettings: readSentimentSearchSettings(),
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || ""),
    limit: parseLimit(body.limit, 30),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/evidence-coverage-routed-alternate-effectiveness
app.get("/collection-jobs/evidence-coverage-routed-alternate-effectiveness", (c) => c.json(getSentimentEvidenceCoverageRoutedAlternateEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/realtime-hot-topics
app.get("/realtime-hot-topics", (c) => c.json(listSentimentRealtimeHotTopics({
  lookbackHours: parseLimit(c.req.query("lookback_hours") || c.req.query("lookbackHours"), 6),
  limit: parseLimit(c.req.query("limit"), 30),
  minCurrent: parseLimit(c.req.query("min_current") || c.req.query("minCurrent"), 2),
})));

// GET /api/plugins/sentiment/sentiment/realtime-anomaly-windows
app.get("/realtime-anomaly-windows", (c) => c.json(listSentimentRealtimeAnomalyWindows({
  windows: c.req.query("windows") || undefined,
  limit: parseLimit(c.req.query("limit"), 50),
  minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 35),
})));

// GET /api/plugins/sentiment/sentiment/keyword-source-family-coverage
app.get("/keyword-source-family-coverage", (c) => c.json(listSentimentKeywordSourceFamilyCoverage({
  days: parseLimit(c.req.query("days"), 14),
  limit: parseLimit(c.req.query("limit"), 50),
  minTotal: parseLimit(c.req.query("min_total") || c.req.query("minTotal"), 1),
  search: readSentimentSearchSettings(),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/keyword-source-family-coverage-effectiveness
app.get("/collection-jobs/keyword-source-family-coverage-effectiveness", (c) => c.json(getSentimentKeywordSourceFamilyCoverageEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/status
app.get("/status", (c) => {
  return c.json(getSentimentMonitorStatus());
});

// GET /api/plugins/sentiment/sentiment/source-schedule
app.get("/source-schedule", (c) => c.json({
  ok: true,
  schedule: listSentimentSourceSchedule(),
}));

// GET /api/plugins/sentiment/sentiment/continuous-collection-plan
app.get("/continuous-collection-plan", (c) => {
  const mode = routeScanMode(c.req.query("mode") || "fast");
  const sources = configuredSourceScopeForMode(c, mode);
  const plan = planSentimentContinuousCollection({
    mode,
    maxSources: parseLimit(c.req.query("max_sources") || c.req.query("maxSources"), 8),
    retryLimit: parseLimit(c.req.query("retry_limit") || c.req.query("retryLimit"), 20),
    searchSettings: routeSearchSettingsWithSources(c, sources),
  });
  return c.json({
    ...plan,
    mode,
    sourceScope: sources?.length ? "admin-settings" : "search-settings",
    requested_sources: sources || null,
  });
});

// GET /api/plugins/sentiment/sentiment/collection-operations
app.get("/collection-operations", (c) => {
  const { mode, sources, sourceScope } = resolveRouteQueryScanSources(c, c.req.query("mode") || "fast");
  const report = getSentimentCollectionOperationsReport({
    mode,
    searchSettings: routeSearchSettingsWithSources(c, sources),
    maxSources: parseLimit(c.req.query("max_sources") || c.req.query("maxSources"), 8),
    retryLimit: parseLimit(c.req.query("retry_limit") || c.req.query("retryLimit"), 20),
    staleMultiplier: parseLimit(c.req.query("stale_multiplier") || c.req.query("staleMultiplier"), 3),
  });
  return c.json({
    ...report,
    mode,
    sourceScope,
    requested_sources: sources || null,
  });
});

// GET /api/plugins/sentiment/sentiment/collection-operations/remediation
app.get("/collection-operations/remediation", (c) => {
  const { mode, sources, sourceScope } = resolveRouteQueryScanSources(c, c.req.query("mode") || "fast");
  const plan = planSentimentCollectionOperationsRemediation({
    mode,
    searchSettings: routeSearchSettingsWithSources(c, sources),
    maxSources: parseLimit(c.req.query("max_sources") || c.req.query("maxSources"), 8),
    retryLimit: parseLimit(c.req.query("retry_limit") || c.req.query("retryLimit"), 20),
    staleMultiplier: parseLimit(c.req.query("stale_multiplier") || c.req.query("staleMultiplier"), 3),
    limit: parseLimit(c.req.query("limit"), 30),
    keywords: parseCsvQuery(c.req.query("keywords") || ""),
  });
  return c.json({
    ...plan,
    mode,
    sourceScope,
    requested_sources: sources || null,
  });
});

// POST /api/plugins/sentiment/sentiment/collection-operations/remediation
app.post("/collection-operations/remediation", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { mode, sources, sourceScope } = resolveRouteScanSources(c, body);
  const applied = applySentimentCollectionOperationsRemediation({
    apply: body.apply === true,
    mode,
    searchSettings: routeSearchSettingsWithSources(c, sources),
    maxSources: parseLimit(body.max_sources || body.maxSources, 8),
    retryLimit: parseLimit(body.retry_limit || body.retryLimit, 20),
    staleMultiplier: parseLimit(body.stale_multiplier || body.staleMultiplier, 3),
    limit: parseLimit(body.limit, 30),
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || ""),
    operator: body.operator || "",
    reason: body.reason || "",
  });
  return c.json({
    ...applied,
    mode,
    sourceScope,
    requested_sources: sources || null,
  });
});

// GET /api/plugins/sentiment/sentiment/collection-quality/operations-remediation
app.get("/collection-quality/operations-remediation", (c) => c.json(listSentimentCollectionOperationsRemediationEffectiveness({
  days: parseLimit(c.req.query("days"), 30),
  limit: parseLimit(c.req.query("limit"), 50),
})));

// GET /api/plugins/sentiment/sentiment/collection-quality/multilingual-queries
app.get("/collection-quality/multilingual-queries", (c) => c.json(listSentimentMultilingualQueryQuality({
  days: parseLimit(c.req.query("days"), 30),
  limit: parseLimit(c.req.query("limit"), 50),
  minSamples: parseLimit(c.req.query("min_samples") || c.req.query("minSamples"), 1),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/multilingual-query-effectiveness
app.get("/collection-jobs/multilingual-query-effectiveness", (c) => c.json(getSentimentMultilingualQueryEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/continuous-collection/run
app.post("/continuous-collection/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const mode = routeScanMode(body.mode || body.scanMode || body.scan_mode || "fast");
  const sources = configuredSourceScopeForMode(c, mode);
  const result = await executeSentimentContinuousCollectionCycle({
    mode,
    maxSources: parseLimit(body.max_sources || body.maxSources, 8),
    retryLimit: parseLimit(body.retry_limit || body.retryLimit, 3),
    postScanFollowupLimit: optionalBodyNumber(body, ["post_scan_followup_limit", "postScanFollowupLimit", "post_scan_evidence_followup_limit", "postScanEvidenceFollowupLimit"]),
    discoveryDeepCrawl: body.discovery_deep_crawl ?? body.discoveryDeepCrawl ?? true,
    discoveryDeepCrawlLimit: parseLimit(body.discovery_deep_crawl_limit || body.discoveryDeepCrawlLimit, 3),
    discoveryDeepCrawlFollowupLimit: optionalBodyNumber(body, ["discovery_deep_crawl_followup_limit", "discoveryDeepCrawlFollowupLimit", "followup_limit", "followupLimit"]),
    searchSettings: routeSearchSettingsWithSources(c, sources),
  });
  return c.json({
    ...result,
    mode,
    sourceScope: sources?.length ? "admin-settings" : "search-settings",
    requested_sources: sources || null,
  });
});

// GET /api/plugins/sentiment/sentiment/source-throttle
app.get("/source-throttle", (c) => c.json({
  ok: true,
  throttle: listSentimentSourceThrottleState(),
}));

// GET /api/plugins/sentiment/sentiment/trends
app.get("/trends", (c) => {
  return c.json(getSentimentTrendSummary({ days: parseLimit(c.req.query("days"), 30) }));
});

// GET /api/plugins/sentiment/sentiment/anomalies
app.get("/anomalies", (c) => {
  return c.json({
    ok: true,
    anomalies: listSentimentAnomalies({
      limit: parseLimit(c.req.query("limit"), 50),
      status: c.req.query("status") || "",
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/architecture
app.get("/architecture", (c) => {
  return c.json(getSentimentArchitectureStatus());
});

// GET /api/plugins/sentiment/sentiment/insights
app.get("/insights", (c) => {
  return c.json({
    insights: listSentimentInsights({
      limit: parseLimit(c.req.query("limit"), 50),
      topic: c.req.query("topic") || "",
      workspaceId: c.req.query("workspace_id") || c.req.query("workspaceId") || "",
      customerId: c.req.query("customer_id") || c.req.query("customerId") || "",
    }),
  });
});

// POST /api/plugins/sentiment/sentiment/insights/reprocess
app.post("/insights/reprocess", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    ok: true,
    result: reprocessSentimentInsights({
      limit: parseLimit(body.limit, 1000),
      workspaceId: body.workspace_id || body.workspaceId || "",
      customerId: body.customer_id || body.customerId || "",
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/evidence
app.get("/evidence", (c) => {
  return c.json({
    ok: true,
    evidence: listSentimentEvidence({
      sentimentId: c.req.query("sentiment_id") || c.req.query("sentimentId") || null,
      limit: parseLimit(c.req.query("limit"), 50),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/evidence-search
app.get("/evidence-search", (c) => {
  return c.json({
    ok: true,
    ...searchSentimentEvidence({
      query: c.req.query("q") || c.req.query("query") || "",
      limit: parseLimit(c.req.query("limit"), 20),
      offset: c.req.query("offset") || "",
      page: c.req.query("page") || "",
      collapse: c.req.query("collapse") || "",
      dedupe: c.req.query("dedupe") || "",
      docTypes: c.req.query("types") || c.req.query("doc_types") || c.req.query("docTypes") || "",
      sourceFamilies: c.req.query("source_families") || c.req.query("sourceFamilies") || c.req.query("families") || "",
      sourceKeys: c.req.query("source_keys") || c.req.query("sourceKeys") || c.req.query("sources") || "",
      platforms: c.req.query("platforms") || c.req.query("platform") || "",
      riskLevels: c.req.query("risk_levels") || c.req.query("riskLevels") || c.req.query("risks") || "",
      includeDomains: c.req.query("include_domains") || c.req.query("includeDomains") || c.req.query("domains") || "",
      excludeDomains: c.req.query("exclude_domains") || c.req.query("excludeDomains") || "",
      excludeTerms: c.req.query("exclude_terms") || c.req.query("excludeTerms") || c.req.query("exclude") || "",
      publishedAfter: c.req.query("published_after") || c.req.query("publishedAfter") || c.req.query("from") || "",
      publishedBefore: c.req.query("published_before") || c.req.query("publishedBefore") || c.req.query("to") || "",
      days: c.req.query("days") || "",
      minEvidenceWeight: c.req.query("min_evidence_weight") || c.req.query("minEvidenceWeight") || "",
      minEvidenceDepth: c.req.query("min_evidence_depth") || c.req.query("minEvidenceDepth") || "",
      sort: c.req.query("sort") || "",
      matchMode: c.req.query("match_mode") || c.req.query("matchMode") || "",
      strictMatch: c.req.query("strict") || c.req.query("strict_match") || c.req.query("strictMatch") || "",
      includeEvents: c.req.query("include_events") === "0" || c.req.query("includeEvents") === "false" ? false : true,
      eventLimit: parseLimit(c.req.query("event_limit") || c.req.query("eventLimit"), 8),
      searchSettings: readSentimentSearchSettings(pluginCtx(c).config),
      rebuild: c.req.query("rebuild") === "1" || c.req.query("rebuild") === "true"
        ? true
        : c.req.query("rebuild") === "0" || c.req.query("rebuild") === "false"
          ? false
          : "auto",
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/search-index/health
app.get("/search-index/health", (c) => c.json(getSentimentSearchIndexHealth({
  autoRebuild: c.req.query("auto_rebuild") === "1" || c.req.query("autoRebuild") === "true",
  maxMissingCount: Number(c.req.query("max_missing") || c.req.query("maxMissing") || 0),
  minCoverageRatio: Number(c.req.query("min_coverage") || c.req.query("minCoverage") || 100),
})));

// POST /api/plugins/sentiment/sentiment/search-index/rebuild
app.post("/search-index/rebuild", (c) => c.json(rebuildSentimentSearchIndex()));

// GET /api/plugins/sentiment/sentiment/fact-claims
app.get("/fact-claims", (c) => {
  return c.json({
    ok: true,
    claims: listSentimentFactClaims({
      eventId: c.req.query("event_id") || c.req.query("eventId") || null,
      sentimentId: c.req.query("sentiment_id") || c.req.query("sentimentId") || null,
      stance: c.req.query("stance") || "",
      claimType: c.req.query("claim_type") || c.req.query("claimType") || "",
      limit: parseLimit(c.req.query("limit"), 100),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/fact-claims/summary
app.get("/fact-claims/summary", (c) => {
  return c.json(summarizeSentimentFactClaims({
    eventId: c.req.query("event_id") || c.req.query("eventId") || null,
    sentimentId: c.req.query("sentiment_id") || c.req.query("sentimentId") || null,
    limit: parseLimit(c.req.query("limit"), 200),
  }));
});

// GET /api/plugins/sentiment/sentiment/author-reputation
app.get("/author-reputation", (c) => {
  return c.json({
    ok: true,
    authors: listSentimentAuthorReputationProfiles({
      days: parseLimit(c.req.query("days"), 30),
      limit: parseLimit(c.req.query("limit"), 100),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/coordinated-amplification
app.get("/coordinated-amplification", (c) => {
  return c.json(listSentimentCoordinatedAmplificationSignals({
    days: parseLimit(c.req.query("days"), 14),
    limit: parseLimit(c.req.query("limit"), 50),
  }));
});

// GET /api/plugins/sentiment/sentiment/content-similarity-clusters
app.get("/content-similarity-clusters", (c) => {
  return c.json(listSentimentContentSimilarityClusters({
    days: parseLimit(c.req.query("days"), 14),
    limit: parseLimit(c.req.query("limit"), 50),
    minItems: parseLimit(c.req.query("min_items") || c.req.query("minItems"), 2),
  }));
});

// GET /api/plugins/sentiment/sentiment/social-followup-signals
app.get("/social-followup-signals", (c) => {
  return c.json(listSentimentSocialFollowupSignals({
    days: parseLimit(c.req.query("days"), 14),
    limit: parseLimit(c.req.query("limit"), 50),
    minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 25),
  }));
});

// GET /api/plugins/sentiment/sentiment/official-regulatory-followup-signals
app.get("/official-regulatory-followup-signals", (c) => {
  const signals = deriveOfficialRegulatoryFollowupSourceSignals({
    days: parseLimit(c.req.query("days"), 14),
    limit: parseLimit(c.req.query("limit"), 120),
  });
  const sources = Object.values(signals);
  return c.json({
    ok: true,
    days: parseLimit(c.req.query("days"), 14),
    generated_at: new Date().toISOString(),
    summary: {
      source_count: sources.length,
      highest_score: Math.max(0, ...sources.map(item => Number(item.score || 0))),
      highest_priority_boost: Math.max(0, ...sources.map(item => Number(item.priorityBoost || 0))),
      regulatory_alert_sources: sources.filter(item => (item.tiers || []).includes("regulatory-alert")).length,
      official_consumer_protection_sources: sources.filter(item => (item.tiers || []).includes("official-consumer-protection")).length,
      regulatory_sources: sources.filter(item => (item.tiers || []).includes("regulatory")).length,
    },
    signals,
    sources,
  });
});

// POST /api/plugins/sentiment/sentiment/social-followup-signals/policy
app.post("/social-followup-signals/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentSocialFollowupPolicy({
    days: parseLimit(body.days, 14),
    limit: parseLimit(body.limit, 100),
    minScore: parseLimit(body.min_score || body.minScore, 55),
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/volume-precision
app.get("/volume-precision", (c) => {
  return c.json(listSentimentVolumePrecisionReport({
    days: parseLimit(c.req.query("days"), 14),
    limit: parseLimit(c.req.query("limit"), 50),
    minItems: parseLimit(c.req.query("min_items") || c.req.query("minItems"), 2),
    keyword: c.req.query("keyword") || "",
    platform: c.req.query("platform") || "",
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  }));
});

// POST /api/plugins/sentiment/sentiment/fact-claims/rebuild
app.post("/fact-claims/rebuild", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(refreshSentimentFactClaims({
    eventId: body.event_id || body.eventId || null,
    sentimentId: body.sentiment_id || body.sentimentId || null,
    limit: parseLimit(body.limit, 2000),
  }));
});

// GET /api/plugins/sentiment/sentiment/visual-assets
app.get("/visual-assets", (c) => {
  return c.json({
    ok: true,
    assets: listSentimentVisualAssets({
      sentimentId: c.req.query("sentiment_id") || c.req.query("sentimentId") || null,
      limit: parseLimit(c.req.query("limit"), 50),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/comments
app.get("/comments", (c) => {
  return c.json({
    ok: true,
    comments: listSentimentComments({
      sentimentId: c.req.query("sentiment_id") || c.req.query("sentimentId") || null,
      limit: parseLimit(c.req.query("limit"), 100),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/sources
app.get("/sources", (c) => c.json({ ok: true, sources: listSentimentSources() }));

// PUT /api/plugins/sentiment/sentiment/sources/:key
app.put("/sources/:key", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ ok: true, source: upsertSentimentSource({ ...body, source_key: c.req.param("key") }) });
});

// GET /api/plugins/sentiment/sentiment/scan-batches
app.get("/scan-batches", (c) => c.json({
  ok: true,
  batches: listSentimentScanBatches({ limit: parseLimit(c.req.query("limit"), 30) }),
}));

// GET /api/plugins/sentiment/sentiment/scan-source-logs
app.get("/scan-source-logs", (c) => c.json({
  ok: true,
  logs: listSentimentScanSourceLogs({
    batchId: c.req.query("batch_id") || c.req.query("batchId") || null,
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/collection-jobs
app.get("/collection-jobs", (c) => c.json({
  ok: true,
  jobs: listSentimentCollectionJobs({
    batchId: c.req.query("batch_id") || c.req.query("batchId") || null,
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    status: c.req.query("status") || "",
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/collection-jobs/rss-priority-site-gap-recovery
app.get("/collection-jobs/rss-priority-site-gap-recovery", (c) => c.json(getSentimentRssPrioritySiteGapRecoveryReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  configuredPacks: listPublicRssFeedPacks(),
  modePacks: readSentimentSearchSettings(pluginCtx(c).config).rssFeedPacks,
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/rss-native-entry-discovery-recovery
app.get("/collection-jobs/rss-native-entry-discovery-recovery", (c) => c.json(getSentimentRssNativeEntryDiscoveryRecoveryReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  configuredPacks: listPublicRssFeedPacks(),
  modePacks: readSentimentSearchSettings(pluginCtx(c).config).rssFeedPacks,
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/rss-source-family-refresh-recovery
app.get("/collection-jobs/rss-source-family-refresh-recovery", (c) => c.json(getSentimentRssSourceFamilyRefreshRecoveryReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  configuredPacks: listPublicRssFeedPacks(),
  modePacks: readSentimentSearchSettings(pluginCtx(c).config).rssFeedPacks,
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/evidence-coverage-followup-recovery
app.get("/collection-jobs/evidence-coverage-followup-recovery", (c) => c.json(getSentimentEvidenceCoverageFollowupRecoveryReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/retry-plan
app.get("/collection-jobs/retry-plan", (c) => c.json({
  ok: true,
  ...listSentimentCollectionJobRetryPlan({
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    status: c.req.query("status") || "",
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// POST /api/plugins/sentiment/sentiment/collection-jobs/requeue
app.post("/collection-jobs/requeue", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(requeueSentimentCollectionJobs({
    jobIds: body.job_ids || body.jobIds || [],
    sourceKey: body.source_key || body.sourceKey || "",
    status: body.status || "",
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    limit: body.limit || 100,
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/recoverable-followups
app.get("/collection-jobs/recoverable-followups", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 30);
  const keywords = parseCsvQuery(c.req.query("keywords") || "");
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const includeFreeTargetCoverage = optionalBoolean(c.req.query("include_free_source_target_coverage_followups") ?? c.req.query("includeFreeSourceTargetCoverageFollowups"), true);
  const base = await planSentimentRecoverableFollowupJobs({
    days: c.req.query("days") || 14,
    limit,
    minScore: c.req.query("min_score") || c.req.query("minScore") || 65,
    freshnessDays: c.req.query("freshnessDays") || c.req.query("freshness_days") || 7,
    keywords,
    includeDeepCrawl: optionalBoolean(c.req.query("include_deep_crawl") ?? c.req.query("includeDeepCrawl"), true),
    includeSocialFollowup: optionalBoolean(c.req.query("include_social_followup") ?? c.req.query("includeSocialFollowup"), true),
    includeAccessBarrierAlternates: optionalBoolean(c.req.query("include_access_barrier_alternates") ?? c.req.query("includeAccessBarrierAlternates"), true),
    includeRssPrioritySiteGaps: optionalBoolean(c.req.query("include_rss_priority_site_gaps") ?? c.req.query("includeRssPrioritySiteGaps"), true),
    includeRssNativeEntryDiscovery: optionalBoolean(c.req.query("include_rss_native_entry_discovery") ?? c.req.query("includeRssNativeEntryDiscovery"), true),
    includeRssSourceFamilyRefresh: optionalBoolean(c.req.query("include_rss_source_family_refresh") ?? c.req.query("includeRssSourceFamilyRefresh"), true),
    includeEvidenceCoverageFollowups: optionalBoolean(c.req.query("include_evidence_coverage_followups") ?? c.req.query("includeEvidenceCoverageFollowups"), true),
    includePostScanEvidenceFollowups: optionalBoolean(c.req.query("include_post_scan_evidence_followups") ?? c.req.query("includePostScanEvidenceFollowups"), true),
    includeCollectionOperationsRemediation: optionalBoolean(c.req.query("include_collection_operations_remediation") ?? c.req.query("includeCollectionOperationsRemediation"), true),
    postScanBatchId: c.req.query("post_scan_batch_id") || c.req.query("postScanBatchId") || c.req.query("batch_id") || c.req.query("batchId") || 0,
    configuredPacks: listPublicRssFeedPacks(),
    modePacks: searchSettings.rssFeedPacks,
  });
  if (includeFreeTargetCoverage === false) return c.json(base);
  const freeTarget = planSentimentFreeSourceTargetCoverageFollowupJobs({
    searchSettings,
    keywords,
    limit,
  });
  return c.json(mergeRecoverableFreeTargetCoveragePlan(base, freeTarget, limit));
});

// POST /api/plugins/sentiment/sentiment/collection-jobs/recoverable-followups
app.post("/collection-jobs/recoverable-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const limit = parseLimit(body.limit, 30);
  const keywords = Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || "");
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const includeFreeTargetCoverage = optionalBoolean(body.include_free_source_target_coverage_followups ?? body.includeFreeSourceTargetCoverageFollowups, true);
  const base = await applySentimentRecoverableFollowupJobs({
    apply: body.apply === true,
    days: body.days || 14,
    limit,
    minScore: body.min_score || body.minScore || 65,
    freshnessDays: body.freshnessDays || body.freshness_days || 7,
    keywords,
    includeDeepCrawl: optionalBoolean(body.include_deep_crawl ?? body.includeDeepCrawl, true),
    includeSocialFollowup: optionalBoolean(body.include_social_followup ?? body.includeSocialFollowup, true),
    includeAccessBarrierAlternates: optionalBoolean(body.include_access_barrier_alternates ?? body.includeAccessBarrierAlternates, true),
    includeRssPrioritySiteGaps: optionalBoolean(body.include_rss_priority_site_gaps ?? body.includeRssPrioritySiteGaps, true),
    includeRssNativeEntryDiscovery: optionalBoolean(body.include_rss_native_entry_discovery ?? body.includeRssNativeEntryDiscovery, true),
    includeRssSourceFamilyRefresh: optionalBoolean(body.include_rss_source_family_refresh ?? body.includeRssSourceFamilyRefresh, true),
    includeEvidenceCoverageFollowups: optionalBoolean(body.include_evidence_coverage_followups ?? body.includeEvidenceCoverageFollowups, true),
    includePostScanEvidenceFollowups: optionalBoolean(body.include_post_scan_evidence_followups ?? body.includePostScanEvidenceFollowups, true),
    includeCollectionOperationsRemediation: optionalBoolean(body.include_collection_operations_remediation ?? body.includeCollectionOperationsRemediation, true),
    postScanBatchId: body.post_scan_batch_id || body.postScanBatchId || body.batch_id || body.batchId || 0,
    configuredPacks: listPublicRssFeedPacks(),
    modePacks: searchSettings.rssFeedPacks,
    operator: body.operator || "",
    reason: body.reason || "",
  });
  if (includeFreeTargetCoverage === false) return c.json(base);
  const freeTarget = applySentimentFreeSourceTargetCoverageFollowupJobs({
    apply: body.apply === true,
    searchSettings,
    keywords,
    limit,
    operator: body.operator || "",
    reason: body.reason || "",
  });
  return c.json(mergeAppliedRecoverableFreeTargetCoverage(base, freeTarget));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/evidence-coverage-followups
app.get("/collection-jobs/evidence-coverage-followups", (c) => c.json(planSentimentEvidenceCoverageFollowupJobs({
  query: c.req.query("query") || "",
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
  days: c.req.query("days") || 7,
  limit: parseLimit(c.req.query("limit"), 30),
  evidenceLimit: parseLimit(c.req.query("evidence_limit") || c.req.query("evidenceLimit"), 18),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/evidence-coverage-followups
app.post("/collection-jobs/evidence-coverage-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentEvidenceCoverageFollowupJobs({
    apply: body.apply === true,
    query: body.query || "",
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || ""),
    days: body.days || 7,
    limit: body.limit || 30,
    evidenceLimit: body.evidence_limit || body.evidenceLimit || 18,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/post-scan-evidence-followups
app.get("/collection-jobs/post-scan-evidence-followups", (c) => c.json(planSentimentPostScanEvidenceFollowupJobs({
  batchId: c.req.query("batch_id") || c.req.query("batchId") || 0,
  days: c.req.query("days") || 7,
  limit: parseLimit(c.req.query("limit"), 30),
  evidenceLimit: parseLimit(c.req.query("evidence_limit") || c.req.query("evidenceLimit"), 18),
  minAverageDepth: c.req.query("min_average_depth") || c.req.query("minAverageDepth") || 55,
  maxThinEvidence: c.req.query("max_thin_evidence") || c.req.query("maxThinEvidence") || 0,
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/post-scan-evidence-followups
app.post("/collection-jobs/post-scan-evidence-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentPostScanEvidenceFollowupJobs({
    apply: body.apply === true,
    batchId: body.batch_id || body.batchId || 0,
    days: body.days || 7,
    limit: body.limit || 30,
    evidenceLimit: body.evidence_limit || body.evidenceLimit || 18,
    minAverageDepth: body.min_average_depth || body.minAverageDepth || 55,
    maxThinEvidence: body.max_thin_evidence || body.maxThinEvidence || 0,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/rss-native-entry-promotion-refresh
app.get("/collection-jobs/rss-native-entry-promotion-refresh", (c) => c.json(planSentimentRssNativeEntryPromotionRefreshJobs({
  days: c.req.query("days") || 30,
  freshnessDays: c.req.query("freshnessDays") || c.req.query("freshness_days") || 14,
  limit: parseLimit(c.req.query("limit"), 30),
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/rss-native-entry-promotion-refresh
app.post("/collection-jobs/rss-native-entry-promotion-refresh", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRssNativeEntryPromotionRefreshJobs({
    apply: body.apply === true,
    days: body.days || 30,
    freshnessDays: body.freshnessDays || body.freshness_days || 14,
    limit: body.limit || 30,
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || ""),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/rss-native-entry-promotion-refresh-recovery
app.get("/collection-jobs/rss-native-entry-promotion-refresh-recovery", (c) => c.json(getSentimentRssNativeEntryPromotionRefreshRecoveryReport({
  days: c.req.query("days") || 30,
  freshnessDays: c.req.query("freshnessDays") || c.req.query("freshness_days") || 14,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/native-entry-promotion-governance
app.get("/rss-feed-pack-coverage/native-entry-promotion-governance", (c) => c.json(getSentimentRssNativeEntryPromotionGovernanceReport({
  days: c.req.query("days") || 30,
  freshnessDays: c.req.query("freshnessDays") || c.req.query("freshness_days") || 14,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/native-entry-promotion-governance/apply
app.post("/rss-feed-pack-coverage/native-entry-promotion-governance/apply", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRssNativeEntryPromotionGovernancePolicy({
    apply: body.apply === true,
    disable: body.disable === true,
    days: body.days || 30,
    freshnessDays: body.freshnessDays || body.freshness_days || 14,
    limit: body.limit || 100,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// POST /api/plugins/sentiment/sentiment/collection-jobs/execute-due
app.post("/collection-jobs/execute-due", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await executeDueSentimentCollectionJobs({
    sourceKey: body.source_key || body.sourceKey || "",
    limit: body.limit || 5,
    searchSettings: pluginCtx(c).config,
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/quality-feedback
app.get("/collection-jobs/quality-feedback", (c) => c.json({
  ok: true,
  ...listSentimentRetryQualityFeedback({
    days: c.req.query("days") || 14,
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/collection-jobs/quality-feedback/policy
app.get("/collection-jobs/quality-feedback/policy", (c) => c.json(applySentimentRetryQualityFeedbackPolicy({
  config: pluginCtx(c).config,
  days: c.req.query("days") || 14,
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  apply: false,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/quality-feedback/policy
app.post("/collection-jobs/quality-feedback/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRetryQualityFeedbackPolicy({
    config: pluginCtx(c).config,
    days: body.days || 14,
    sourceKey: body.source_key || body.sourceKey || "",
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    limit: body.limit || 100,
  }));
});

// GET /api/plugins/sentiment/sentiment/source-quality
app.get("/source-quality", (c) => c.json({
  ok: true,
  profiles: listSentimentSourceQualityProfiles({
    days: c.req.query("days") || 7,
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/source-quality/auto-governance
app.get("/source-quality/auto-governance", (c) => c.json(listSentimentSourceAutoGovernancePolicy({
  days: c.req.query("days") || 14,
  limit: parseLimit(c.req.query("limit"), 100),
  minSamples: c.req.query("min_samples") || c.req.query("minSamples") || 5,
  minScans: c.req.query("min_scans") || c.req.query("minScans") || 2,
})));

// POST /api/plugins/sentiment/sentiment/source-quality/auto-governance
app.post("/source-quality/auto-governance", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentSourceAutoGovernancePolicy({
    days: body.days || 14,
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    limit: body.limit || 100,
    minSamples: body.minSamples || body.min_samples || 5,
    minScans: body.minScans || body.min_scans || 2,
  }));
});

// GET /api/plugins/sentiment/sentiment/source-quality/domains
app.get("/source-quality/domains", (c) => c.json({
  ok: true,
  profiles: listSentimentDomainQualityProfiles({
    days: c.req.query("days") || 14,
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/source-quality/domains/policy
app.get("/source-quality/domains/policy", (c) => c.json(applySentimentDomainQualityPolicy({
  days: c.req.query("days") || 14,
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  apply: false,
  limit: parseLimit(c.req.query("limit"), 100),
  minSamples: c.req.query("min_samples") || c.req.query("minSamples") || 5,
})));

// POST /api/plugins/sentiment/sentiment/source-quality/domains/policy
app.post("/source-quality/domains/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentDomainQualityPolicy({
    days: body.days || 14,
    sourceKey: body.source_key || body.sourceKey || "",
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    limit: body.limit || 100,
    minSamples: body.min_samples || body.minSamples || 5,
  }));
});

// GET /api/plugins/sentiment/sentiment/source-coverage
app.get("/source-coverage", (c) => c.json({
  ok: true,
  ...listSentimentSourceCoverageScores({
    days: c.req.query("days") || 7,
    limit: parseLimit(c.req.query("limit"), 200),
    now: Number.isFinite(new Date(c.req.query("now") || "").getTime())
      ? new Date(c.req.query("now")).getTime()
      : Date.now(),
  }),
}));

// GET /api/plugins/sentiment/sentiment/source-reliability
app.get("/source-reliability", (c) => c.json({
  ok: true,
  ...listSentimentSourceReliabilityReport({
    days: c.req.query("days") || 14,
    limit: parseLimit(c.req.query("limit"), 200),
  }),
}));

// GET /api/plugins/sentiment/sentiment/source-credibility
app.get("/source-credibility", (c) => c.json(getSentimentSourceCredibilityReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 200),
})));

// GET /api/plugins/sentiment/sentiment/source-discovery
app.get("/source-discovery", (c) => c.json(listSentimentSourceDiscoveryCandidates({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/source-discovery/validate
app.get("/source-discovery/validate", async (c) => c.json(await validateSentimentSourceDiscoveryCandidates({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  minScore: c.req.query("min_score") || c.req.query("minScore") || 45,
  candidateTypes: parseCsvQuery(c.req.query("types") || c.req.query("candidate_types") || "author-profile"),
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
  timeoutMs: c.req.query("timeout_ms") || c.req.query("timeoutMs") || 8000,
})));

// GET /api/plugins/sentiment/sentiment/source-discovery/deep-crawl-plan
app.get("/source-discovery/deep-crawl-plan", async (c) => c.json(await listSentimentSourceDiscoveryDeepCrawlPlan({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  minScore: c.req.query("min_score") || c.req.query("minScore") || 45,
  candidateTypes: parseCsvQuery(c.req.query("types") || c.req.query("candidate_types") || "rss-feed,sitemap,author-profile,related-domain,deep-crawl-outlink"),
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
  timeoutMs: c.req.query("timeout_ms") || c.req.query("timeoutMs") || 8000,
  targetLimit: parseLimit(c.req.query("target_limit") || c.req.query("targetLimit"), 80),
  includeCaptured: c.req.query("include_captured") === "true" || c.req.query("includeCaptured") === "true",
  includeSeen: c.req.query("include_seen") === "true" || c.req.query("includeSeen") === "true",
})));

// POST /api/plugins/sentiment/sentiment/source-discovery/deep-crawl-plan/execute
app.post("/source-discovery/deep-crawl-plan/execute", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await executeSentimentSourceDiscoveryDeepCrawlPlan({
    days: body.days || 30,
    limit: body.limit || 100,
    minScore: body.min_score || body.minScore || 45,
    candidateTypes: body.types || body.candidate_types || body.candidateTypes || ["rss-feed", "sitemap", "author-profile"],
    keywords: body.keywords || [],
    timeoutMs: body.timeout_ms || body.timeoutMs || 8000,
    targetLimit: body.target_limit || body.targetLimit || 20,
    followupLimit: body.followup_limit || body.followupLimit || body.max_followup_targets || body.maxFollowupTargets || 0,
    includeCaptured: body.include_captured === true || body.includeCaptured === true,
    includeSeen: body.include_seen === true || body.includeSeen === true,
    proxyUrl: body.proxy_url || body.proxyUrl || "",
    apply: body.apply === true,
  }));
});

// POST /api/plugins/sentiment/sentiment/source-discovery/policy
app.post("/source-discovery/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await applySentimentSourceDiscoveryPolicy({
    days: body.days || 30,
    limit: body.limit || 100,
    minScore: body.min_score || body.minScore || 70,
    validate: body.validate ?? true,
    trackProfiles: body.track_profiles === true || body.trackProfiles === true,
    validateProfiles: body.validate_profiles ?? body.validateProfiles ?? true,
    trackDomains: body.track_domains === true || body.trackDomains === true,
    trackApps: body.track_apps === true || body.trackApps === true,
    trackPodcasts: body.track_podcasts === true || body.trackPodcasts === true,
    keywords: body.keywords || [],
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/source-reliability/policy
app.get("/source-reliability/policy", (c) => c.json(applySentimentSourceReliabilityPolicy({
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  days: c.req.query("days") || 14,
  apply: false,
  limit: parseLimit(c.req.query("limit"), 200),
})));

// POST /api/plugins/sentiment/sentiment/source-reliability/policy
app.post("/source-reliability/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentSourceReliabilityPolicy({
    sourceKey: body.source_key || body.sourceKey || "",
    days: body.days || 14,
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    limit: body.limit || 200,
  }));
});

// GET /api/plugins/sentiment/sentiment/entity-recall-gaps
app.get("/entity-recall-gaps", (c) => c.json({
  ok: true,
  ...listSentimentEntityRecallGaps({
    config: pluginCtx(c).config,
    days: c.req.query("days") || 14,
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/entity-topic-recall-gaps
app.get("/entity-topic-recall-gaps", (c) => c.json({
  ok: true,
  ...listSentimentEntityTopicRecallGaps({
    config: pluginCtx(c).config,
    days: c.req.query("days") || 14,
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/entity-topic-source-recall-gaps
app.get("/entity-topic-source-recall-gaps", (c) => c.json({
  ok: true,
  ...listSentimentEntityTopicSourceRecallGaps({
    config: pluginCtx(c).config,
    days: c.req.query("days") || 14,
    limit: parseLimit(c.req.query("limit"), 200),
  }),
}));

// GET /api/plugins/sentiment/sentiment/entity-recall-trend
app.get("/entity-recall-trend", (c) => c.json({
  ok: true,
  ...listSentimentEntityRecallTrend({
    config: pluginCtx(c).config,
    days: c.req.query("days") || 30,
    bucketDays: c.req.query("bucket_days") || c.req.query("bucketDays") || 7,
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/entity-topic-recall-trend
app.get("/entity-topic-recall-trend", (c) => c.json({
  ok: true,
  ...listSentimentEntityTopicRecallTrend({
    config: pluginCtx(c).config,
    days: c.req.query("days") || 30,
    bucketDays: c.req.query("bucket_days") || c.req.query("bucketDays") || 7,
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/entity-recall-gaps/policy
app.get("/entity-recall-gaps/policy", (c) => c.json(applySentimentEntityRecallPolicy({
  config: pluginCtx(c).config,
  days: c.req.query("days") || 14,
  apply: false,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/entity-recall-gaps/policy
app.post("/entity-recall-gaps/policy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentEntityRecallPolicy({
    config: pluginCtx(c).config,
    days: body.days || 14,
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
    limit: body.limit || 100,
  }));
});

// GET /api/plugins/sentiment/sentiment/source-recovery
app.get("/source-recovery", (c) => c.json({
  ok: true,
  ...listSentimentSourceRecoverySummary({
    days: c.req.query("days") || 7,
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/source-recovery/audit
app.get("/source-recovery/audit", (c) => c.json({
  ok: true,
  audits: listSentimentSourceRecoveryAudit({
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    limit: parseLimit(c.req.query("limit"), 50),
  }),
}));

// POST /api/plugins/sentiment/sentiment/source-recovery/audit/:id/rollback
app.post("/source-recovery/audit/:id/rollback", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(rollbackSentimentSourceRecoveryAudit({
    config: pluginCtx(c).config,
    auditId: c.req.param("id"),
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// POST /api/plugins/sentiment/sentiment/source-recovery/playbook
app.post("/source-recovery/playbook", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentSourceRecoveryPlaybook({
    config: pluginCtx(c).config,
    sourceKey: body.source_key || body.sourceKey || "",
    days: body.days || 7,
    actionNames: body.actions || body.actionNames || body.action_names || [],
    apply: body.apply === true,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-quality
app.get("/collection-quality", (c) => c.json({
  ok: true,
  ...listSentimentCollectionContributionScores({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 20),
  }),
}));

// GET /api/plugins/sentiment/sentiment/collection-quality/noise-suppression
app.get("/collection-quality/noise-suppression", (c) => c.json(listSentimentNoiseSuppressionReport({
  days: c.req.query("days") || 14,
  limit: parseLimit(c.req.query("limit"), 50),
  minSamples: parseLimit(c.req.query("min_samples") || c.req.query("minSamples"), 2),
})));

// GET /api/plugins/sentiment/sentiment/collection-quality/access-barrier-alternates
app.get("/collection-quality/access-barrier-alternates", (c) => c.json(listAccessBarrierAlternateRecoveryEffectiveness({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 50),
})));

// GET /api/plugins/sentiment/sentiment/deep-collection-health
app.get("/deep-collection-health", (c) => c.json({
  ok: true,
  ...listSentimentDeepCollectionHealthProfiles({
    days: c.req.query("days") || 14,
    sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
    limit: parseLimit(c.req.query("limit"), 100),
  }),
}));

// GET /api/plugins/sentiment/sentiment/evidence-depth
app.get("/evidence-depth", (c) => c.json(listSentimentEvidenceDepthReport({
  days: c.req.query("days") || 30,
  sourceKey: c.req.query("source_key") || c.req.query("sourceKey") || "",
  sentimentId: c.req.query("sentiment_id") || c.req.query("sentimentId") || null,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/evidence-chain-gaps
app.get("/evidence-chain-gaps", (c) => c.json(listSentimentEvidenceChainGapReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 50),
  minGapScore: parseLimit(c.req.query("min_gap_score") || c.req.query("minGapScore"), 20),
})));

// GET /api/plugins/sentiment/sentiment/rss-feed-packs
app.get("/rss-feed-packs", (c) => c.json({
  ok: true,
  packs: listPublicRssFeedPacks(),
}));

// GET /api/plugins/sentiment/sentiment/rss-feed-pack-coverage
app.get("/rss-feed-pack-coverage", (c) => c.json(listSentimentRssFeedPackCoverage({
  days: c.req.query("days") || 30,
  freshnessDays: c.req.query("freshnessDays") || c.req.query("freshness_days") || 7,
  limit: parseLimit(c.req.query("limit"), 100),
  configuredPacks: listPublicRssFeedPacks(),
  modePacks: readSentimentSearchSettings(pluginCtx(c).config).rssFeedPacks,
})));

// GET /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/taiwan-media-health
app.get("/rss-feed-pack-coverage/taiwan-media-health", (c) => c.json(getSentimentTaiwanMediaSourceHealthReport({
  packKey: c.req.query("pack") || c.req.query("pack_key") || "taiwanMedia",
  configuredPacks: listPublicRssFeedPacks(),
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/taiwan-public-interest-health
app.get("/rss-feed-pack-coverage/taiwan-public-interest-health", (c) => c.json(getSentimentTaiwanMediaSourceHealthReport({
  packKey: c.req.query("pack") || c.req.query("pack_key") || "taiwanPublicInterest",
  configuredPacks: listPublicRssFeedPacks(),
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/native-entry-candidates
app.get("/rss-feed-pack-coverage/native-entry-candidates", (c) => c.json(listSentimentRssNativeEntryPromotionCandidates({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  minEvidence: c.req.query("min_evidence") || c.req.query("minEvidence") || 1,
  minRelevance: c.req.query("min_relevance") || c.req.query("minRelevance") || 40,
})));

// GET /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/native-entry-promotion-effectiveness
app.get("/rss-feed-pack-coverage/native-entry-promotion-effectiveness", (c) => c.json(getSentimentRssNativeEntryPromotionEffectivenessReport({
  days: c.req.query("days") || 30,
  freshnessDays: c.req.query("freshnessDays") || c.req.query("freshness_days") || 14,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/native-entry-candidates/apply
app.post("/rss-feed-pack-coverage/native-entry-candidates/apply", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRssNativeEntryPromotionCandidates({
    apply: body.apply === true && body.dryRun !== true && body.dry_run !== true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 100),
    minEvidence: body.min_evidence || body.minEvidence || 1,
    minRelevance: body.min_relevance || body.minRelevance || 40,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// POST /api/plugins/sentiment/sentiment/rss-feed-pack-coverage/apply-recommendations
app.post("/rss-feed-pack-coverage/apply-recommendations", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRssModeCoverageRecommendations({
    config: pluginCtx(c).config,
    days: body.days || 30,
    freshnessDays: body.freshnessDays || body.freshness_days || 7,
    limit: parseLimit(body.limit, 100),
    configuredPacks: listPublicRssFeedPacks(),
    apply: body.apply !== false && body.dryRun !== true && body.dry_run !== true,
  }));
});

// GET /api/plugins/sentiment/sentiment/query-template-packs
app.get("/query-template-packs", (c) => c.json({
  ok: true,
  packs: listSentimentQueryTemplatePacks(),
}));

// POST /api/plugins/sentiment/sentiment/source-quality/tune
app.post("/source-quality/tune", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    ok: true,
    result: applySentimentSourceQualityTuning({
      days: body.days || 7,
      dryRun: body.dryRun === true || body.dry_run === true,
      minSamples: body.minSamples || body.min_samples || 5,
      minScans: body.minScans || body.min_scans || 2,
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/alert-rules
app.get("/alert-rules", (c) => c.json({ ok: true, rules: listSentimentAlertRules() }));

// POST /api/plugins/sentiment/sentiment/alert-rules
app.post("/alert-rules", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ ok: true, rule: upsertSentimentAlertRule(body) }, 201);
});

// PUT /api/plugins/sentiment/sentiment/alert-rules/:key
app.put("/alert-rules/:key", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ ok: true, rule: upsertSentimentAlertRule({ ...body, rule_key: c.req.param("key") }) });
});

// GET /api/plugins/sentiment/sentiment/analysis
app.get("/analysis", (c) => {
  return c.json(getSentimentInsightSummary({
    days: parseLimit(c.req.query("days"), 30),
    workspaceId: c.req.query("workspace_id") || c.req.query("workspaceId") || "",
    customerId: c.req.query("customer_id") || c.req.query("customerId") || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/compare?keywords=a,b
app.get("/compare", (c) => {
  return c.json(compareSentimentTopics({
    keywords: c.req.query("keywords") || "",
    days: parseLimit(c.req.query("days"), 30),
    workspaceId: c.req.query("workspace_id") || c.req.query("workspaceId") || "",
    customerId: c.req.query("customer_id") || c.req.query("customerId") || "",
  }));
});

// POST /api/plugins/sentiment/sentiment/ask
app.post("/ask", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const input = {
    question: body.question || body.q || "",
    limit: parseLimit(body.limit, 8),
    workspaceId: body.workspace_id || body.workspaceId || "",
    customerId: body.customer_id || body.customerId || "",
  };
  const useAi = body.ai === true || body.use_ai === true || body.useAi === true;
  if (!useAi) return c.json(answerSentimentQuestion(input));
  return c.json(await answerSentimentQuestionWithAi({
    ...input,
    aiSettings: {
      ...readSentimentAiSettings(pluginCtx(c).config),
      ...(body.ai_settings || body.aiSettings || {}),
    },
  }));
});

// GET /api/plugins/sentiment/sentiment/crisis-briefs
app.get("/crisis-briefs", (c) => {
  return c.json({
    ok: true,
    briefs: listCrisisBriefs({
      eventId: c.req.query("event_id") || c.req.query("eventId") || null,
      limit: parseLimit(c.req.query("limit"), 20),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/ai-settings
app.get("/ai-settings", (c) => {
  const settings = readSentimentAiSettings(pluginCtx(c).config);
  if (c.req.query("reveal") === "1" || c.req.query("showKey") === "1") {
    return c.json({
      settings: {
        ...settings,
        configured: Boolean(settings.baseUrl && settings.apiKey && settings.model),
      },
    });
  }
  return c.json({ settings: maskSentimentAiSettings(settings) });
});

// PUT /api/plugins/sentiment/sentiment/ai-settings
app.put("/ai-settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ settings: writeSentimentAiSettings(pluginCtx(c).config, body) });
});

// POST /api/plugins/sentiment/sentiment/crisis-briefs
app.post("/crisis-briefs", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const useAi = body.use_ai === true || body.useAi === true || body.ai === true || body.enhance === true;
  const ctx = pluginCtx(c);
  const input = {
    eventId: body.event_id || body.eventId || null,
    limit: parseLimit(body.limit, 20),
    persist: body.persist !== false,
  };
  const brief = useAi
    ? await generateCrisisBriefWithAi({
        ...input,
        aiSettings: {
          ...readSentimentAiSettings(ctx.config),
          ...(body.ai_settings || body.aiSettings || {}),
        },
      })
    : generateCrisisBrief(input);
  return c.json({
    ok: true,
    mode: useAi ? "ai" : "local",
    brief,
  }, 201);
});

// GET /api/plugins/sentiment/sentiment/report
app.get("/report", async (c) => {
  const ctx = pluginCtx(c);
  const report = await buildSentimentReportMarkdownWithAi({
    days: parseLimit(c.req.query("days"), 7),
    scanResult: getLastSentimentScanResult(),
    query: c.req.query("q") || c.req.query("keyword") || "",
    aiSettings: readSentimentAiSettings(ctx.config),
  });
  return c.json({
    ...report,
    dashboard: getSentimentDashboard({ limit: 50 }),
  });
});

// GET /api/plugins/sentiment/sentiment/migration-export.jsonl
app.get("/migration-export.jsonl", (c) => {
  const jsonl = buildSentimentMigrationJsonl({
    limit: parseLimit(c.req.query("limit"), 1000),
    workspaceId: c.req.query("workspace_id") || c.req.query("workspaceId") || "",
    customerId: c.req.query("customer_id") || c.req.query("customerId") || "",
  });
  return new Response(jsonl, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"sentiment-migration.jsonl\"",
    },
  });
});

// GET /api/plugins/sentiment/sentiment/export.csv
app.get("/export.csv", (c) => {
  const csv = buildSentimentCsv({
    limit: parseLimit(c.req.query("limit"), 200),
    workspaceId: c.req.query("workspace_id") || c.req.query("workspaceId") || "",
    customerId: c.req.query("customer_id") || c.req.query("customerId") || "",
  });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"sentiment-report.csv\"",
    },
  });
});

// GET /api/plugins/sentiment/sentiment/report-schedules
app.get("/report-schedules", (c) => {
  return c.json({
    schedules: listSentimentReportSchedules({
      workspaceId: c.req.query("workspace_id") || c.req.query("workspaceId") || "",
      customerId: c.req.query("customer_id") || c.req.query("customerId") || "",
    }),
  });
});

// POST /api/plugins/sentiment/sentiment/report-schedules
app.post("/report-schedules", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ schedule: createSentimentReportSchedule(body) }, 201);
});

// DELETE /api/plugins/sentiment/sentiment/report-schedules/:id
app.delete("/report-schedules/:id", (c) => {
  const ok = deleteSentimentReportSchedule(c.req.param("id"));
  if (!ok) return c.json({ error: "schedule not found" }, 404);
  return c.json({ ok: true });
});

// GET /api/plugins/sentiment/sentiment/events
app.get("/events", (c) => {
  return c.json({
    events: listSentimentEvents({
      limit: parseLimit(c.req.query("limit"), 20),
      status: c.req.query("status") || "",
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/event-edges
app.get("/event-edges", (c) => {
  return c.json({
    edges: listSentimentEventEdges({
      eventId: c.req.query("event_id") || c.req.query("eventId") || null,
      limit: parseLimit(c.req.query("limit"), 100),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/spread-graph
app.get("/spread-graph", (c) => {
  return c.json({
    ok: true,
    graph: buildSentimentSpreadGraph({
      limit: parseLimit(c.req.query("limit"), 50),
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/event-clusters
app.get("/event-clusters", (c) => c.json(getSentimentEventClusterAnalysisReport({
  limit: parseLimit(c.req.query("limit"), 50),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/event-cluster-followup-effectiveness
app.get("/collection-jobs/event-cluster-followup-effectiveness", (c) => c.json(getSentimentEventClusterFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/alerts
app.get("/alerts", (c) => {
  return c.json({
    alerts: listSentimentAlerts({
      limit: parseLimit(c.req.query("limit"), 20),
      status: c.req.query("status") || "",
    }),
  });
});

// GET /api/plugins/sentiment/sentiment/notifications
app.get("/notifications", (c) => {
  return c.json({
    settings: readSentimentNotificationSettings(pluginCtx(c).config),
    notifications: listSentimentNotifications({ limit: parseLimit(c.req.query("limit"), 20) }),
  });
});

// PUT /api/plugins/sentiment/sentiment/notifications
app.put("/notifications", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ settings: writeSentimentNotificationSettings(pluginCtx(c).config, body) });
});

// GET /api/plugins/sentiment/sentiment/opensearch-settings
app.get("/opensearch-settings", (c) => {
  const settings = readSentimentSearchSettings(pluginCtx(c).config).openSearch || {};
  if (c.req.query("reveal") === "1" || c.req.query("showKey") === "1") {
    return c.json({
      ok: true,
      settings: {
        ...settings,
        configured: Boolean(settings.endpoint && (settings.apiKey || settings.username || settings.accessMode === "direct")),
      },
    });
  }
  return c.json({ ok: true, settings: maskSentimentOpenSearchSettings(settings) });
});

// PUT /api/plugins/sentiment/sentiment/opensearch-settings
app.put("/opensearch-settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = readSentimentSearchSettings(pluginCtx(c).config);
  const settings = writeSentimentSearchSettings(pluginCtx(c).config, {
    ...current,
    openSearch: {
      ...(current.openSearch || {}),
      ...body,
    },
  });
  return c.json({ ok: true, settings: maskSentimentOpenSearchSettings(settings.openSearch) });
});

// GET /api/plugins/sentiment/sentiment/opensearch-health
app.get("/opensearch-health", async (c) => {
  const settings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(await getSentimentOpenSearchHealth(settings));
});

// POST /api/plugins/sentiment/sentiment/opensearch-sync
app.post("/opensearch-sync", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(await syncSentimentOpenSearchArchive(settings, {
    limit: parseSyncLimit(body.limit || c.req.query("limit"), settings.openSearch?.maxSyncItems || 1000),
    dryRun: body.dryRun === true || body.dry_run === true || c.req.query("dry_run") === "1" || c.req.query("dryRun") === "true",
  }));
});

// POST /api/plugins/sentiment/sentiment/opensearch-maintenance
app.post("/opensearch-maintenance", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(await maintainSentimentOpenSearchArchive(settings, {
    dryRun: body.dryRun !== false && body.dry_run !== false && c.req.query("dry_run") !== "0" && c.req.query("dryRun") !== "false",
  }));
});

// POST /api/plugins/sentiment/sentiment/notifications/:id/retry
app.post("/notifications/:id/retry", async (c) => {
  const ctx = pluginCtx(c);
  const notification = await retrySentimentNotification(c.req.param("id"), {
    bus: ctx.bus,
    log: ctx.log,
  });
  if (!notification) return c.json({ error: "notification not found" }, 404);
  return c.json({ ok: true, notification });
});

// GET /api/plugins/sentiment/sentiment/search-settings
app.get("/search-settings", (c) => {
  return c.json({ settings: readSentimentSearchSettings(pluginCtx(c).config) });
});

// PUT /api/plugins/sentiment/sentiment/search-settings
app.put("/search-settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({ settings: writeSentimentSearchSettings(pluginCtx(c).config, body) });
});

app.options("/browser-auth/cookies", (c) => corsJson(c, { ok: true }));

app.get("/browser-auth/profiles", (c) => {
  const settings = readSentimentSearchSettings(pluginCtx(c).config);
  const profiles = browserAuthProfilesForClient(settings);
  return corsJson(c, {
    ok: true,
    summary: browserAuthProfilesSummaryForClient(profiles),
    profiles,
  });
});

app.post("/browser-auth/cookies", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ctx = pluginCtx(c);
  const settings = readSentimentSearchSettings(ctx.config);
  if (!browserAuthRequestAuthorized(c, settings)) {
    return corsJson(c, { ok: false, error: "invalid browser auth token" }, 403);
  }
  const browserFallback = settings.browserFallback || {};
  const profiles = Array.isArray(browserFallback.profiles) ? browserFallback.profiles : [];
  const profileKey = cleanCookieValue(body.profileKey || body.profile_key || body.key, 80);
  const sourceKey = cleanCookieValue(body.sourceKey || body.source_key, 80);
  const domain = cleanCookieValue(body.domain || body.host, 240).replace(/^www\./, "");
  const rawCookies = Array.isArray(body.cookies) ? body.cookies : [];
  const cookies = activeBrowserAuthCookies(rawCookies
    .map(cookie => normalizeBrowserAuthCookie(cookie, domain))
    .filter(Boolean)
    .slice(0, 120));
  if (!cookies.length) return corsJson(c, { ok: false, error: "cookies must not be empty" }, 400);

  const index = profiles.findIndex(profile => {
    const profileDomain = String(profile.domain || "").replace(/^\.+/, "").replace(/^www\./, "");
    return (profileKey && profile.key === profileKey)
      || (sourceKey && profile.sourceKey === sourceKey)
      || (domain && profileDomain && (domain === profileDomain || domain.endsWith(`.${profileDomain}`)));
  });
  if (index < 0) return corsJson(c, { ok: false, error: "browser auth profile not found" }, 404);

  const nextProfiles = profiles.map((profile, profileIndex) => profileIndex === index
    ? {
      ...profile,
      cookies,
      lastAuthorizedAt: new Date().toISOString(),
    }
    : profile);
  const normalized = writeSentimentSearchSettings(ctx.config, {
    ...settings,
    browserFallback: {
      ...browserFallback,
      profiles: nextProfiles,
    },
  });
  const profile = browserAuthProfilesForClient(normalized).find(item => item.key === nextProfiles[index].key);
  return corsJson(c, {
    ok: true,
    profile,
    savedCookieCount: cookies.length,
  });
});

// GET /api/plugins/sentiment/sentiment/monitored-entities
app.get("/monitored-entities", (c) => {
  const settings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json({ ok: true, monitoredEntities: settings.monitoredEntities });
});

// PUT /api/plugins/sentiment/sentiment/monitored-entities
app.put("/monitored-entities", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = readSentimentSearchSettings(pluginCtx(c).config);
  const monitoredEntities = Array.isArray(body)
    ? { entities: body }
    : body.monitoredEntities || body.monitored_entities || body;
  const settings = writeSentimentSearchSettings(pluginCtx(c).config, {
    ...current,
    monitoredEntities,
  });
  return c.json({ ok: true, monitoredEntities: settings.monitoredEntities, settings });
});

// POST /api/plugins/sentiment/sentiment/alerts/:id/ack
app.post("/alerts/:id/ack", (c) => {
  const alert = acknowledgeSentimentAlert(c.req.param("id"));
  if (!alert) return c.json({ error: "alert not found" }, 404);
  return c.json({ ok: true, alert });
});

// POST /api/plugins/sentiment/sentiment/alerts/:id/status
app.post("/alerts/:id/status", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const alert = updateSentimentAlertStatus(c.req.param("id"), body.status);
  if (!alert) return c.json({ error: "alert not found or invalid status" }, 404);
  return c.json({ ok: true, alert });
});

// GET /api/plugins/sentiment/sentiment/alerts/:id/actions
app.get("/alerts/:id/actions", (c) => {
  return c.json({
    ok: true,
    actions: listSentimentAlertActions({
      alertId: c.req.param("id"),
      limit: parseLimit(c.req.query("limit"), 50),
    }),
  });
});

// POST /api/plugins/sentiment/sentiment/alerts/:id/actions
app.post("/alerts/:id/actions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const action = createSentimentAlertAction(c.req.param("id"), body);
  if (!action) return c.json({ error: "alert not found" }, 404);
  return c.json({ ok: true, action }, 201);
});

// PATCH /api/plugins/sentiment/sentiment/alerts/:id/actions/:actionId
app.patch("/alerts/:id/actions/:actionId", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const action = updateSentimentAlertAction(c.req.param("id"), c.req.param("actionId"), body);
  if (!action) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true, action });
});

// POST /api/plugins/sentiment/sentiment/alerts/:id/notify
app.post("/alerts/:id/notify", (c) => {
  const ctx = pluginCtx(c);
  const result = dispatchSentimentAlertNotifications({
    alertId: c.req.param("id"),
    bus: ctx.bus,
    log: ctx.log,
    notificationSettings: readSentimentNotificationSettings(ctx.config),
  });
  if (!result) return c.json({ error: "alert not found" }, 404);
  return c.json({ ok: true, ...result });
});

// POST /api/plugins/sentiment/sentiment/events/:id/status
app.post("/events/:id/status", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const event = updateSentimentEventStatus(c.req.param("id"), body.status);
  if (!event) return c.json({ error: "event not found" }, 404);
  return c.json({ ok: true, event });
});

// POST /api/plugins/sentiment/sentiment/read/:id
app.post("/read/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const db = getDb();
  db.prepare("UPDATE crm_sentiment SET is_read = 1 WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// GET /api/plugins/sentiment/sentiment/keywords
app.get("/keywords", (c) => {
  const db = getDb();
  const keywords = db.prepare("SELECT * FROM crm_keywords ORDER BY created_at DESC").all();
  return c.json(keywords);
});

// POST /api/plugins/sentiment/sentiment/keywords
app.post("/keywords", async (c) => {
  const { keyword } = await c.req.json();
  const keywords = normalizeSentimentMonitorKeywords(keyword);
  if (!keywords.length) return c.json({ error: "keyword required" }, 400);
  const db = getDb();
  const insert = db.prepare("INSERT OR IGNORE INTO crm_keywords (keyword) VALUES (?)");
  const ids = [];
  for (const value of keywords) {
    if (value.length > 100) return c.json({ error: "keyword too long (max 100)" }, 400);
    const result = insert.run(value);
    if (result.lastInsertRowid) ids.push(Number(result.lastInsertRowid));
  }
  return c.json({
    id: ids[0] || null,
    keyword: keywords[0],
    keywords,
    inserted: ids.length,
  }, 201);
});

// DELETE /api/plugins/sentiment/sentiment/keywords/:id
app.delete("/keywords/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const db = getDb();
  db.prepare("DELETE FROM crm_keywords WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// POST /api/plugins/sentiment/sentiment/scan
app.post("/scan", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const reason = ["manual", "schedule", "watch"].includes(String(body.reason || "")) ? String(body.reason) : "manual";
    const { mode, rawSources, sources, sourceScope } = resolveRouteScanSources(c, body);
    if (rawSources !== undefined && !sources?.length) {
      return c.json({ ok: false, error: "sources must not be empty when provided", status: getSentimentMonitorStatus() }, 400);
    }
    const invalidSources = invalidSourceKeys(sources);
    if (invalidSources.length) {
      return c.json({ ok: false, error: `unknown sources: ${invalidSources.join(", ")}`, status: getSentimentMonitorStatus() }, 400);
    }
    const result = await runSentimentScanNow({ reason, mode, sources, days: body.days || body.scanDays || body.scan_days });
    return c.json({
      ok: true,
      result,
      status: getSentimentMonitorStatus(),
      dashboard: getSentimentDashboard({ limit: 50 }),
      mode,
      sourceScope,
      sources: sources || null,
    });
  } catch (err) {
    const message = err?.message || String(err);
    return c.json({ ok: false, error: message, status: getSentimentMonitorStatus() }, 500);
  }
});

// POST /api/plugins/sentiment/sentiment/scan-start
app.post("/scan-start", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const reason = ["manual", "schedule", "watch"].includes(String(body.reason || "")) ? String(body.reason) : "manual";
    const { mode, rawSources, sources, sourceScope } = resolveRouteScanSources(c, body);
    if (rawSources !== undefined && !sources?.length) {
      return c.json({ ok: false, error: "sources must not be empty when provided", status: { running: Boolean(getSentimentMonitorStatus().running) } }, 400);
    }
    const invalidSources = invalidSourceKeys(sources);
    if (invalidSources.length) {
      return c.json({ ok: false, error: `unknown sources: ${invalidSources.join(", ")}`, status: { running: Boolean(getSentimentMonitorStatus().running) } }, 400);
    }
    const startedAt = new Date().toISOString();
    const currentStatus = getSentimentMonitorStatus();
    const ctx = pluginCtx(c);
    const alreadyRunning = Boolean(currentStatus.running) || Boolean(ctx.isBackgroundScanRunning?.());
    const { log } = ctx;
    if (!alreadyRunning) {
      const job = { reason, mode, sources, days: body.days || body.scanDays || body.scan_days };
      if (typeof ctx.startBackgroundScan === "function") {
        ctx.startBackgroundScan(job);
      } else {
        setTimeout(() => {
          runSentimentScanNow(job).catch(error => {
            log?.error?.("[sentiment-routes] background scan failed", error?.message || String(error));
          });
        }, 0);
      }
    }
    return c.json({
      ok: true,
      accepted: true,
      started: !alreadyRunning,
      alreadyRunning,
      startedAt,
      status: alreadyRunning ? currentStatus : { running: true },
      mode,
      sourceScope,
      sources: sources || null,
      days: Math.max(1, Math.min(365, Number(body.days || body.scanDays || body.scan_days || 30) || 30)),
    }, 202);
  } catch (err) {
    const message = err?.message || String(err);
    return c.json({ ok: false, error: message, status: getSentimentMonitorStatus() }, 500);
  }
});

// POST /api/plugins/sentiment/sentiment/watch-scan
app.post("/watch-scan", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { mode, rawSources, sources, sourceScope } = resolveRouteScanSources(c, { ...body, mode: body.mode || body.scanMode || "watch" });
    if (rawSources !== undefined && !sources?.length) {
      return c.json({ ok: false, error: "sources must not be empty when provided", status: getSentimentMonitorStatus() }, 400);
    }
    const invalidSources = invalidSourceKeys(sources);
    if (invalidSources.length) {
      return c.json({ ok: false, error: `unknown sources: ${invalidSources.join(", ")}`, status: getSentimentMonitorStatus() }, 400);
    }
    const result = await runSentimentScanNow({ reason: "watch", mode, sources, days: body.days || body.scanDays || body.scan_days });
    return c.json({
      ok: true,
      result,
      status: getSentimentMonitorStatus(),
      dashboard: getSentimentDashboard({ limit: 50 }),
      mode,
      sourceScope,
      sources: sources || null,
    });
  } catch (err) {
    const message = err?.message || String(err);
    return c.json({ ok: false, error: message, status: getSentimentMonitorStatus() }, 500);
  }
});

// POST /api/plugins/sentiment/sentiment/monitor
app.post("/monitor", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.enabled === false) {
    stopSentimentScheduler();
    return c.json(getSentimentMonitorStatus());
  }

  const minutes = Math.max(1, Math.min(24 * 60, Number(body.intervalMinutes) || 5));
  const mode = body.mode || body.scanMode || "fast";
  const scanMode = routeScanMode(mode);
  const sources = configuredSourceScopeForMode(c, scanMode);
  const watchSources = configuredSourceScopeForMode(c, "watch");
  const search = readSentimentSearchSettings(pluginCtx(c).config);
  const watchEnabled = body.watchEnabled === false || body.watch_enabled === false
    ? false
    : search.highRiskWatch?.enabled !== false;
  const watchIntervalMinutes = Math.max(1, Math.min(60, Number(
    body.watchIntervalMinutes || body.watch_interval_minutes || search.highRiskWatch?.intervalMinutes || 2
  ) || 2));
  return c.json(startSentimentScheduler({
    intervalMs: minutes * 60 * 1000,
    mode: scanMode,
    sources,
    watchEnabled,
    watchIntervalMs: watchIntervalMinutes * 60 * 1000,
    watchSources,
  }));
});

// POST /api/plugins/sentiment/sentiment/ingest
// 供 AI 工具或本地流程把已核查的公開輿情結果結構化寫回 CRM。
app.post("/ingest", async (c) => {
  const startedAtIso = new Date(Date.now() - 1000).toISOString();
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return c.json({ error: "items must be a non-empty array" }, 400);
  }

  const result = insertSentimentItems(items, {
    ...(body.defaults || {}),
    source_type: body.source_type || body.sourceType || "manual",
  });
  const ctx = pluginCtx(c);
  const touchedCount = result.inserted + (result.updated || 0);
  const intelligence = touchedCount > 0
    ? processSentimentIntelligence({
      since: startedAtIso,
      bus: ctx.bus,
      log: ctx.log,
      notificationSettings: readSentimentNotificationSettings(ctx.config),
    })
    : { events: [], alerts: [], createdAlerts: 0, notifications: [] };
  return c.json({
    ok: true,
    inserted: result.inserted,
    updated: result.updated || 0,
    skipped: result.skipped,
    intelligence,
    dashboard: getSentimentDashboard({ limit: 50 }),
  }, 201);
});

export const __test__ = {
  routeScanMode,
  configuredSourceScopeForMode,
  resolveRouteScanSources,
  routeSearchSettingsWithSources,
  browserCookieState,
  activeBrowserAuthCookies,
  browserAuthProfilesForClient,
  browserAuthProfilesSummaryForClient,
};

export default app;
