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
  getSentimentAlertEventFollowupEffectivenessReport,
  getSentimentEventClusterFollowupEffectivenessReport,
  getSentimentEvidenceCoverageFollowupRecoveryReport,
  getSentimentEvidenceCoverageRoutedAlternateEffectivenessReport,
  getSentimentFreeSourceTargetCoverageEffectivenessReport,
  getSentimentInsightSummary,
  getSentimentKeywordSourceFamilyCoverageEffectivenessReport,
  getSentimentMultilingualQueryEffectivenessReport,
  getSentimentHighValueEvidenceCorroborationEffectivenessReport,
  getSentimentHighValueEvidenceFollowupEffectivenessReport,
  getSentimentHighRiskEvidenceRevisitEffectivenessReport,
  getSentimentFactClaimCorroborationEffectivenessReport,
  getSentimentSourceFailurePersistentRecoveryEffectivenessReport,
  getSentimentDeepCrawlChainGapFollowupEffectivenessReport,
  getSentimentHistoricalWindowBackfillEffectivenessReport,
  getSentimentAuthorPivotFollowupEffectivenessReport,
  getSentimentAuthorReputationFollowupEffectivenessReport,
  getSentimentPostScanRealtimeKeywordExpansionEffectivenessReport,
  getSentimentRealtimeKeywordExpansionCandidateFanoutEffectivenessReport,
  getSentimentRealtimeKeywordExpansionFamilyFanoutEffectivenessReport,
  getSentimentKeywordRealtimeExpansionRouteFollowupEffectivenessReport,
  getSentimentRealtimeDiscoveryLatencyReport,
  getSentimentSourceCoverageRefreshFollowupEffectivenessReport,
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
  planSentimentPostScanRealtimeKeywordExpansionJobs,
  planSentimentSourceFailurePersistentRecoveryJobs,
  planSentimentHistoricalWindowBackfillJobs,
  planSentimentDeepCrawlChainGapFollowupJobs,
  planSentimentAuthorPivotFollowupJobs,
  planSentimentAuthorReputationFollowupJobs,
  planSentimentCommercialQueryFanoutFollowupJobs,
  planSentimentRealtimeKeywordExpansionFollowupJobs,
  planSentimentRealtimeKeywordExpansionFamilyFanoutJobs,
  planSentimentKeywordRealtimeExpansionRouteFollowupJobs,
  planSentimentOpenSearchArchiveFeedbackFollowupJobs,
  planSentimentHighValueEvidenceFollowupJobs,
  planSentimentHighRiskEvidenceRevisitJobs,
  planSentimentHighValueEvidenceCorroborationJobs,
  listSentimentHighValueEvidenceCorroborationGaps,
  planSentimentFactClaimCorroborationJobs,
  listSentimentFactClaimCorroborationGaps,
  planSentimentSourceCoverageRefreshFollowupJobs,
  planSentimentKeywordSourceFamilyCoverageFollowupJobs,
  planSentimentRssNativeEntryPromotionRefreshJobs,
  applySentimentCommercialQueryFanoutFollowupJobs,
  applySentimentRealtimeKeywordExpansionFollowupJobs,
  applySentimentRealtimeKeywordExpansionFamilyFanoutJobs,
  applySentimentKeywordRealtimeExpansionRouteFollowupJobs,
  applySentimentPostScanRealtimeKeywordExpansionJobs,
  applySentimentSourceFailurePersistentRecoveryJobs,
  applySentimentHistoricalWindowBackfillJobs,
  applySentimentDeepCrawlChainGapFollowupJobs,
  applySentimentAuthorPivotFollowupJobs,
  applySentimentAuthorReputationFollowupJobs,
  applySentimentOpenSearchArchiveFeedbackFollowupJobs,
  applySentimentHighValueEvidenceFollowupJobs,
  applySentimentHighRiskEvidenceRevisitJobs,
  applySentimentHighValueEvidenceCorroborationJobs,
  applySentimentFactClaimCorroborationJobs,
  applySentimentSourceCoverageRefreshFollowupJobs,
  applySentimentKeywordSourceFamilyCoverageFollowupJobs,
  listSentimentCommercialQueryFanoutEffectiveness,
  listSentimentCollectionContributionScores,
  listSentimentMultilingualQueryQuality,
  listSentimentRealtimeKeywordExpansionEffectiveness,
  listSentimentNoiseSuppressionReport,
  listSentimentEvidence,
  listSentimentDeepCrawlEvidenceChains,
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
  getSentimentSourceDiscoveryDeepCrawlEffectivenessReport,
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
  getSentimentOpenSearchArchiveOutboxStatus,
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
  maintainSentimentSearchIndex,
  getSentimentOpenSearchHealth,
  getSentimentOpenSearchArchiveFeedbackReport,
  getSentimentOpenSearchArchiveFeedbackFollowupEffectivenessReport,
  expandSentimentSearchKeywordsRealtime,
  planSentimentKeywordRealtimeExpansionLayer,
  getSentimentRealtimeKeywordExpansionLayerReport,
  maintainSentimentOpenSearchArchive,
  maintainSentimentCollectionJobBacklog,
  listSentimentOpenSearchArchiveOutbox,
  purgeSentimentOpenSearchArchiveOutbox,
  recoverSentimentOpenSearchArchiveOutbox,
  listSentimentSourceQualityDrift,
  syncSentimentOpenSearchArchiveOutbox,
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
  applySentimentAlertEventFollowupJobs,
  applySentimentEventClusterFollowupJobs,
  applySentimentFreeSourceTargetCoverageFollowupJobs,
  applySentimentCollectionOperationsRemediation,
  executeSentimentContinuousCollectionCycle,
  executeDueSentimentCollectionJobs,
  executeDueSentimentCollectionJobDrain,
  getSentimentContinuousCollectionRun,
  getSentimentCollectionOperationsReport,
  getSentimentCollectionOperationsFastReport,
  getSentimentFreeSourceTargetCoverageReport,
  getSentimentRealtimeSourceCoverageReport,
  listSentimentContinuousCollectionRuns,
  planSentimentAlertEventFollowupJobs,
  planSentimentEventClusterFollowupJobs,
  planSentimentFreeSourceTargetCoverageFollowupJobs,
  planSentimentCollectionOperationsRemediation,
  planSentimentContinuousCollection,
  listSentimentSourceSchedule,
  listSentimentSourceThrottleState,
  listSentimentQueryTemplatePacks,
  runSentimentScanNow,
  startSentimentContinuousCollectionRun,
  startSentimentScheduler,
  stopSentimentScheduler,
} from "../scrapers/runner.js";

const app = new Hono();

function parseLimit(raw, fallback = 50) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(200, Math.max(1, value));
}

function parseNonNegativeLimit(raw, fallback = 0, max = 200) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, value));
}

function parseSyncLimit(raw, fallback = 1000) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(10000, Math.max(1, value));
}

function mergeRequestOpenSearchSettings(baseSettings = {}, body = {}) {
  const override = body.openSearch || body.open_search || null;
  if (!override || typeof override !== "object" || Array.isArray(override)) return baseSettings;
  return {
    ...baseSettings,
    openSearch: {
      ...(baseSettings.openSearch || baseSettings.open_search || {}),
      ...override,
    },
  };
}

function parseCooldownHours(raw, fallback = 6) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(168, value));
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

function parseRouteKeywords(body = {}, queryKeywords = "") {
  const input = body.keywords ?? body.keyword ?? body.q ?? body.query ?? queryKeywords;
  return normalizeSentimentMonitorKeywords(input);
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

const COLLECTION_JOB_EXECUTION_FILTERS = [
  ["postScanEvidenceFollowupsOnly", ["post_scan_evidence_followups_only", "postScanEvidenceFollowupsOnly"]],
  ["postScanRealtimeKeywordExpansionOnly", ["post_scan_realtime_keyword_expansion_only", "postScanRealtimeKeywordExpansionOnly"]],
  ["sourceFamilyCoverageFollowupsOnly", ["source_family_coverage_followups_only", "sourceFamilyCoverageFollowupsOnly"]],
  ["keywordSourceFamilyCoverageFollowupsOnly", ["keyword_source_family_coverage_followups_only", "keywordSourceFamilyCoverageFollowupsOnly"]],
  ["realtimeKeywordExpansionFollowupsOnly", ["realtime_keyword_expansion_followups_only", "realtimeKeywordExpansionFollowupsOnly"]],
  ["keywordRealtimeExpansionRouteFollowupsOnly", ["keyword_realtime_expansion_route_followups_only", "keywordRealtimeExpansionRouteFollowupsOnly"]],
  ["commercialQueryFanoutFollowupsOnly", ["commercial_query_fanout_followups_only", "commercialQueryFanoutFollowupsOnly"]],
  ["commercialQueryFanoutDeepCrawlFollowupsOnly", ["commercial_query_fanout_deep_crawl_followups_only", "commercialQueryFanoutDeepCrawlFollowupsOnly"]],
  ["openSearchArchiveFeedbackFollowupsOnly", ["opensearch_archive_feedback_followups_only", "open_search_archive_feedback_followups_only", "openSearchArchiveFeedbackFollowupsOnly"]],
  ["openSearchArchiveDeepCrawlFollowupsOnly", ["opensearch_archive_deep_crawl_followups_only", "open_search_archive_deep_crawl_followups_only", "openSearchArchiveDeepCrawlFollowupsOnly"]],
  ["highValueEvidenceFollowupsOnly", ["high_value_evidence_followups_only", "highValueEvidenceFollowupsOnly"]],
  ["highValueEvidenceDeepCrawlFollowupsOnly", ["high_value_evidence_deep_crawl_followups_only", "highValueEvidenceDeepCrawlFollowupsOnly"]],
  ["highRiskEvidenceRevisitOnly", ["high_risk_evidence_revisit_only", "highRiskEvidenceRevisitOnly"]],
  ["highRiskEvidenceRevisitDeepCrawlOnly", ["high_risk_evidence_revisit_deep_crawl_only", "highRiskEvidenceRevisitDeepCrawlOnly"]],
  ["highValueEvidenceCorroborationOnly", ["high_value_evidence_corroboration_only", "highValueEvidenceCorroborationOnly"]],
  ["highValueEvidenceCorroborationDeepCrawlOnly", ["high_value_evidence_corroboration_deep_crawl_only", "highValueEvidenceCorroborationDeepCrawlOnly"]],
  ["factClaimCorroborationOnly", ["fact_claim_corroboration_only", "factClaimCorroborationOnly"]],
  ["factClaimCorroborationDeepCrawlOnly", ["fact_claim_corroboration_deep_crawl_only", "factClaimCorroborationDeepCrawlOnly"]],
  ["alertEventFollowupsOnly", ["alert_event_followups_only", "alertEventFollowupsOnly"]],
  ["alertEventDeepCrawlFollowupsOnly", ["alert_event_deep_crawl_followups_only", "alertEventDeepCrawlFollowupsOnly"]],
  ["sourceFailurePersistentRecoveryFollowupsOnly", ["source_failure_persistent_recovery_followups_only", "sourceFailurePersistentRecoveryFollowupsOnly"]],
  ["sourceCoverageRefreshFollowupsOnly", ["source_coverage_refresh_followups_only", "sourceCoverageRefreshFollowupsOnly"]],
  ["freeSourceTargetCoverageFollowupsOnly", ["free_source_target_coverage_followups_only", "freeSourceTargetCoverageFollowupsOnly"]],
  ["eventClusterFollowupsOnly", ["event_cluster_followups_only", "eventClusterFollowupsOnly"]],
  ["eventClusterDeepCrawlFollowupsOnly", ["event_cluster_deep_crawl_followups_only", "eventClusterDeepCrawlFollowupsOnly"]],
  ["historicalWindowBackfillOnly", ["historical_window_backfill_only", "historicalWindowBackfillOnly"]],
  ["authorPivotFollowupsOnly", ["author_pivot_followups_only", "authorPivotFollowupsOnly"]],
  ["authorPivotDeepCrawlFollowupsOnly", ["author_pivot_deep_crawl_followups_only", "authorPivotDeepCrawlFollowupsOnly"]],
  ["authorReputationFollowupsOnly", ["author_reputation_followups_only", "authorReputationFollowupsOnly"]],
  ["authorReputationDeepCrawlFollowupsOnly", ["author_reputation_deep_crawl_followups_only", "authorReputationDeepCrawlFollowupsOnly"]],
  ["deepCrawlChainGapFollowupsOnly", ["deep_crawl_chain_gap_followups_only", "deepCrawlChainGapFollowupsOnly"]],
];

const COLLECTION_JOB_TASK_TYPE_FILTERS = {
  "post-scan-evidence-followup": "postScanEvidenceFollowupsOnly",
  "post-scan-realtime-keyword-expansion": "postScanRealtimeKeywordExpansionOnly",
  "source-family-coverage-followup": "sourceFamilyCoverageFollowupsOnly",
  "keyword-source-family-coverage-followup": "keywordSourceFamilyCoverageFollowupsOnly",
  "realtime-keyword-expansion-followup": "realtimeKeywordExpansionFollowupsOnly",
  "keyword-realtime-expansion-route-followup": "keywordRealtimeExpansionRouteFollowupsOnly",
  "commercial-query-fanout-followup": "commercialQueryFanoutFollowupsOnly",
  "commercial-query-fanout-deep-crawl-followup": "commercialQueryFanoutDeepCrawlFollowupsOnly",
  "opensearch-archive-feedback-followup": "openSearchArchiveFeedbackFollowupsOnly",
  "opensearch-archive-deep-crawl-followup": "openSearchArchiveDeepCrawlFollowupsOnly",
  "high-value-evidence-followup": "highValueEvidenceFollowupsOnly",
  "high-value-evidence-deep-crawl-followup": "highValueEvidenceDeepCrawlFollowupsOnly",
  "high-risk-evidence-revisit": "highRiskEvidenceRevisitOnly",
  "high-risk-evidence-revisit-deep-crawl": "highRiskEvidenceRevisitDeepCrawlOnly",
  "high-value-evidence-corroboration": "highValueEvidenceCorroborationOnly",
  "high-value-evidence-corroboration-deep-crawl": "highValueEvidenceCorroborationDeepCrawlOnly",
  "fact-claim-corroboration": "factClaimCorroborationOnly",
  "fact-claim-corroboration-deep-crawl": "factClaimCorroborationDeepCrawlOnly",
  "alert-event-followup": "alertEventFollowupsOnly",
  "alert-event-deep-crawl-followup": "alertEventDeepCrawlFollowupsOnly",
  "source-failure-persistent-recovery": "sourceFailurePersistentRecoveryFollowupsOnly",
  "source-coverage-refresh-followup": "sourceCoverageRefreshFollowupsOnly",
  "free-source-target-coverage-followup": "freeSourceTargetCoverageFollowupsOnly",
  "event-cluster-followup": "eventClusterFollowupsOnly",
  "event-cluster-deep-crawl-followup": "eventClusterDeepCrawlFollowupsOnly",
  "historical-window-backfill": "historicalWindowBackfillOnly",
  "author-pivot-followup": "authorPivotFollowupsOnly",
  "author-pivot-deep-crawl-followup": "authorPivotDeepCrawlFollowupsOnly",
  "author-reputation-followup": "authorReputationFollowupsOnly",
  "author-reputation-deep-crawl-followup": "authorReputationDeepCrawlFollowupsOnly",
  "deep-crawl-chain-gap-followup": "deepCrawlChainGapFollowupsOnly",
};

function normalizeCollectionJobTaskType(raw = "") {
  return String(raw || "").trim().replace(/_/g, "-").toLowerCase();
}

function collectionJobExecutionOptionsForRoute(body = {}) {
  const options = {
    sourceKey: body.source_key || body.sourceKey || "",
    limit: parseLimit(body.limit, 5),
    concurrency: parseLimit(body.concurrency, 1),
    collectionJobTimeoutMs: optionalBodyNumber(body, [
      "collection_job_timeout_ms",
      "collectionJobTimeoutMs",
      "source_timeout_ms",
      "sourceTimeoutMs",
    ]),
    drainBatches: optionalBodyNumber(body, [
      "drain_batches",
      "drainBatches",
      "collection_job_drain_batches",
      "collectionJobDrainBatches",
      "collection_job_backlog_drain_batches",
      "collectionJobBacklogDrainBatches",
      "backlog_drain_batches",
      "backlogDrainBatches",
    ]),
  };
  for (const [optionKey, aliases] of COLLECTION_JOB_EXECUTION_FILTERS) {
    const raw = optionalBodyNumber(body, aliases);
    if (raw !== undefined) options[optionKey] = optionalBoolean(raw, false);
  }
  const taskTypes = parseSourceList(body.task_type ?? body.taskType ?? body.job_type ?? body.jobType) || [];
  for (const taskType of taskTypes.map(normalizeCollectionJobTaskType)) {
    const optionKey = COLLECTION_JOB_TASK_TYPE_FILTERS[taskType];
    if (optionKey) options[optionKey] = true;
  }
  return options;
}

async function executeCollectionJobsForRoute(options = {}, { searchSettings = null, log = null } = {}) {
  const { drainBatches, collectionJobTimeoutMs, limit, concurrency, ...collectionOptions } = options || {};
  const safeDrainBatches = Math.max(1, Math.min(5, Number(drainBatches) || 1));
  if (safeDrainBatches > 1) {
    return executeDueSentimentCollectionJobDrain({
      batches: safeDrainBatches,
      limit,
      concurrency,
      collectionJobTimeoutMs,
      collectionOptions,
      searchSettings,
      log,
    });
  }
  return executeDueSentimentCollectionJobs({
    ...collectionOptions,
    limit,
    concurrency,
    collectionJobTimeoutMs,
    searchSettings,
  });
}

async function continuousCollectionPreviewForRoute(c, body = {}) {
  const ctx = pluginCtx(c);
  const mode = routeScanMode(body.mode || body.scanMode || body.scan_mode || "fast");
  const sources = configuredSourceScopeForMode(c, mode);
  const searchSettings = routeSearchSettingsWithSources(c, sources);
  const maxSources = parseLimit(body.max_sources || body.maxSources, 8);
  const retryLimit = parseLimit(body.retry_limit || body.retryLimit, 3);
  const scanSources = optionalBoolean(body.scan_sources ?? body.scanSources ?? body.execute_scan ?? body.executeScan, true);
  const plan = planSentimentContinuousCollection({
    mode,
    maxSources,
    retryLimit: Math.max(retryLimit, 20),
    searchSettings,
  });
  const qualityDays = searchSettings?.collectionQualityFeedback?.days || 14;
  const realtimeExpansionFollowups = body.realtime_expansion_followups ?? body.realtimeExpansionFollowups ?? true;
  const realtimeExpansionFollowupLimit = optionalBodyNumber(body, ["realtime_expansion_followup_limit", "realtimeExpansionFollowupLimit", "realtime_keyword_expansion_followup_limit", "realtimeKeywordExpansionFollowupLimit"]);
  const safeRealtimeExpansionFollowupLimit = realtimeExpansionFollowupLimit === null || realtimeExpansionFollowupLimit === undefined
    ? Math.min(3, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(realtimeExpansionFollowupLimit) || 0));
  const realtimeExpansionFollowupPreview = realtimeExpansionFollowups !== false && safeRealtimeExpansionFollowupLimit > 0
    ? planSentimentRealtimeKeywordExpansionFollowupJobs({
      days: qualityDays,
      limit: safeRealtimeExpansionFollowupLimit,
      minScore: optionalBodyNumber(body, ["realtime_expansion_followup_min_score", "realtimeExpansionFollowupMinScore", "realtime_keyword_expansion_followup_min_score", "realtimeKeywordExpansionFollowupMinScore"]) ?? 45,
      minResultCount: optionalBodyNumber(body, ["realtime_expansion_followup_min_result_count", "realtimeExpansionFollowupMinResultCount", "realtime_keyword_expansion_followup_min_result_count", "realtimeKeywordExpansionFollowupMinResultCount"]) ?? 1,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: realtimeExpansionFollowups === false
        ? "realtime-expansion-followups-disabled"
        : "realtime-expansion-followup-limit-zero",
    };
  const postScanRealtimeKeywordExpansionFollowups = body.post_scan_realtime_keyword_expansion_followups
    ?? body.postScanRealtimeKeywordExpansionFollowups
    ?? true;
  const postScanRealtimeKeywordExpansionFollowupLimit = optionalBodyNumber(body, ["post_scan_realtime_keyword_expansion_followup_limit", "postScanRealtimeKeywordExpansionFollowupLimit"]);
  const safePostScanRealtimeKeywordExpansionFollowupLimit = postScanRealtimeKeywordExpansionFollowupLimit === null || postScanRealtimeKeywordExpansionFollowupLimit === undefined
    ? Math.min(3, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(12, Number(postScanRealtimeKeywordExpansionFollowupLimit) || 0));
  const postScanRealtimeKeywordExpansionPreview = postScanRealtimeKeywordExpansionFollowups !== false && safePostScanRealtimeKeywordExpansionFollowupLimit > 0
    ? planSentimentPostScanRealtimeKeywordExpansionJobs({
      since: body.since || body.started_at || body.startedAt || new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || body.keyword || body.q || ""),
      searchSettings,
      limit: safePostScanRealtimeKeywordExpansionFollowupLimit,
      minScore: optionalBodyNumber(body, ["post_scan_realtime_keyword_expansion_min_score", "postScanRealtimeKeywordExpansionMinScore"]) ?? 45,
      maxSourcesPerCandidate: optionalBodyNumber(body, ["post_scan_realtime_keyword_expansion_max_sources_per_candidate", "postScanRealtimeKeywordExpansionMaxSourcesPerCandidate"]) ?? 3,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: postScanRealtimeKeywordExpansionFollowups === false
        ? "post-scan-realtime-keyword-expansion-disabled"
        : "post-scan-realtime-keyword-expansion-limit-zero",
    };
  const commercialQueryFanoutFollowups = body.commercial_query_fanout_followups ?? body.commercialQueryFanoutFollowups ?? true;
  const commercialQueryFanoutFollowupLimit = optionalBodyNumber(body, ["commercial_query_fanout_followup_limit", "commercialQueryFanoutFollowupLimit"]);
  const safeCommercialQueryFanoutFollowupLimit = commercialQueryFanoutFollowupLimit === null || commercialQueryFanoutFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(commercialQueryFanoutFollowupLimit) || 0));
  const commercialQueryFanoutFollowupPreview = commercialQueryFanoutFollowups !== false && safeCommercialQueryFanoutFollowupLimit > 0
    ? planSentimentCommercialQueryFanoutFollowupJobs({
      days: qualityDays,
      limit: safeCommercialQueryFanoutFollowupLimit,
      minScore: optionalBodyNumber(body, ["commercial_query_fanout_followup_min_score", "commercialQueryFanoutFollowupMinScore"]) ?? 55,
      minEvidence: optionalBodyNumber(body, ["commercial_query_fanout_followup_min_evidence", "commercialQueryFanoutFollowupMinEvidence"]) ?? 1,
      includeWatch: optionalBoolean(body.commercial_query_fanout_followup_include_watch ?? body.commercialQueryFanoutFollowupIncludeWatch, false),
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: commercialQueryFanoutFollowups === false
        ? "commercial-query-fanout-followups-disabled"
        : "commercial-query-fanout-followup-limit-zero",
    };
  const authorPivotFollowups = body.author_pivot_followups ?? body.authorPivotFollowups ?? true;
  const authorPivotFollowupLimit = optionalBodyNumber(body, ["author_pivot_followup_limit", "authorPivotFollowupLimit"]);
  const safeAuthorPivotFollowupLimit = authorPivotFollowupLimit === null || authorPivotFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(authorPivotFollowupLimit) || 0));
  const authorPivotFollowupPreview = authorPivotFollowups !== false && safeAuthorPivotFollowupLimit > 0
    ? planSentimentAuthorPivotFollowupJobs({
      days: Math.max(qualityDays, 30),
      keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || body.keyword || body.q || ""),
      minMentions: optionalBodyNumber(body, ["author_pivot_min_mentions", "authorPivotMinMentions", "author_pivot_followup_min_mentions", "authorPivotFollowupMinMentions"]) ?? 2,
      minHighRisk: optionalBodyNumber(body, ["author_pivot_min_high_risk", "authorPivotMinHighRisk", "author_pivot_followup_min_high_risk", "authorPivotFollowupMinHighRisk"]) ?? 1,
      maxSourcesPerAuthor: optionalBodyNumber(body, ["author_pivot_max_sources_per_author", "authorPivotMaxSourcesPerAuthor", "author_pivot_followup_max_sources_per_author", "authorPivotFollowupMaxSourcesPerAuthor"]) ?? 3,
      sources,
      limit: safeAuthorPivotFollowupLimit,
      cooldownHours: parseCooldownHours(body.author_pivot_followup_cooldown_hours ?? body.authorPivotFollowupCooldownHours, 12),
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: authorPivotFollowups === false
        ? "author-pivot-followups-disabled"
        : "author-pivot-followup-limit-zero",
    };
  const authorReputationFollowups = body.author_reputation_followups ?? body.authorReputationFollowups ?? true;
  const authorReputationFollowupLimit = optionalBodyNumber(body, ["author_reputation_followup_limit", "authorReputationFollowupLimit"]);
  const safeAuthorReputationFollowupLimit = authorReputationFollowupLimit === null || authorReputationFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(authorReputationFollowupLimit) || 0));
  const authorReputationFollowupPreview = authorReputationFollowups !== false && safeAuthorReputationFollowupLimit > 0
    ? planSentimentAuthorReputationFollowupJobs({
      days: Math.max(qualityDays, 30),
      limit: safeAuthorReputationFollowupLimit,
      minCoordinationRisk: optionalBodyNumber(body, ["author_reputation_min_coordination_risk", "authorReputationMinCoordinationRisk", "author_reputation_followup_min_coordination_risk", "authorReputationFollowupMinCoordinationRisk"]) ?? 55,
      minHighRisk: optionalBodyNumber(body, ["author_reputation_min_high_risk", "authorReputationMinHighRisk", "author_reputation_followup_min_high_risk", "authorReputationFollowupMinHighRisk"]) ?? 1,
      maxReputationScore: optionalBodyNumber(body, ["author_reputation_max_reputation_score", "authorReputationMaxReputationScore", "author_reputation_followup_max_reputation_score", "authorReputationFollowupMaxReputationScore"]) ?? 45,
      cooldownHours: parseCooldownHours(body.author_reputation_followup_cooldown_hours ?? body.authorReputationFollowupCooldownHours, 12),
      searchSettings,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_author_count: 0,
      reason: authorReputationFollowups === false
        ? "author-reputation-followups-disabled"
        : "author-reputation-followup-limit-zero",
    };
  const keywordRealtimeExpansionRouteFollowups = body.keyword_realtime_expansion_route_followups
    ?? body.keywordRealtimeExpansionRouteFollowups
    ?? true;
  const keywordRealtimeExpansionRouteFollowupLimit = optionalBodyNumber(body, ["keyword_realtime_expansion_route_followup_limit", "keywordRealtimeExpansionRouteFollowupLimit"]);
  const safeKeywordRealtimeExpansionRouteFollowupLimit = keywordRealtimeExpansionRouteFollowupLimit === null || keywordRealtimeExpansionRouteFollowupLimit === undefined
    ? Math.min(3, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(12, Number(keywordRealtimeExpansionRouteFollowupLimit) || 0));
  const keywordRealtimeExpansionRouteKeywords = Array.isArray(body.keywords)
    ? body.keywords
    : parseCsvQuery(body.keywords || body.keyword || body.q || "");
  const keywordRealtimeExpansionRouteFollowupPreview = keywordRealtimeExpansionRouteFollowups !== false && safeKeywordRealtimeExpansionRouteFollowupLimit > 0
    ? await planSentimentKeywordRealtimeExpansionRouteFollowupJobs({
      keywords: keywordRealtimeExpansionRouteKeywords,
      mode,
      searchSettings,
      aiSettings: readSentimentAiSettings(pluginCtx(c).config),
      existingKeywords: keywordRealtimeExpansionRouteKeywords,
      limit: safeKeywordRealtimeExpansionRouteFollowupLimit,
      maxSourcesPerPack: optionalBodyNumber(body, ["keyword_realtime_expansion_route_max_sources_per_pack", "keywordRealtimeExpansionRouteMaxSourcesPerPack"]) ?? 2,
      maxKeywordsPerJob: optionalBodyNumber(body, ["keyword_realtime_expansion_route_max_keywords_per_job", "keywordRealtimeExpansionRouteMaxKeywordsPerJob"]) ?? 6,
      minCandidateScore: optionalBodyNumber(body, ["keyword_realtime_expansion_route_min_candidate_score", "keywordRealtimeExpansionRouteMinCandidateScore"]) ?? 0,
      cooldownHours: parseCooldownHours(body.keyword_realtime_expansion_route_cooldown_hours ?? body.keywordRealtimeExpansionRouteCooldownHours, 6),
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: keywordRealtimeExpansionRouteFollowups === false
        ? "keyword-realtime-expansion-route-followups-disabled"
        : "keyword-realtime-expansion-route-followup-limit-zero",
    };
  const openSearchArchiveFeedbackFollowups = body.opensearch_archive_feedback_followups ?? body.openSearchArchiveFeedbackFollowups ?? true;
  const openSearchArchiveFeedbackFollowupLimit = optionalBodyNumber(body, ["opensearch_archive_feedback_followup_limit", "openSearchArchiveFeedbackFollowupLimit", "opensearchArchiveFeedbackFollowupLimit"]);
  const safeOpenSearchArchiveFeedbackFollowupLimit = openSearchArchiveFeedbackFollowupLimit === null || openSearchArchiveFeedbackFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(openSearchArchiveFeedbackFollowupLimit) || 0));
  const openSearchArchiveFeedbackFollowupPreview = openSearchArchiveFeedbackFollowups !== false && safeOpenSearchArchiveFeedbackFollowupLimit > 0
    ? planSentimentOpenSearchArchiveFeedbackFollowupJobs({
      days: Math.max(qualityDays, 30),
      limit: safeOpenSearchArchiveFeedbackFollowupLimit,
      minArchiveScore: optionalBodyNumber(body, ["opensearch_archive_feedback_followup_min_score", "openSearchArchiveFeedbackFollowupMinScore", "opensearchArchiveFeedbackFollowupMinScore", "min_archive_score", "minArchiveScore"]) ?? 60,
      searchSettings,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: openSearchArchiveFeedbackFollowups === false
        ? "opensearch-archive-feedback-followups-disabled"
        : "opensearch-archive-feedback-followup-limit-zero",
    };
  const factClaimCorroborationFollowups = body.fact_claim_corroboration_followups ?? body.factClaimCorroborationFollowups ?? true;
  const factClaimCorroborationFollowupLimit = optionalBodyNumber(body, ["fact_claim_corroboration_followup_limit", "factClaimCorroborationFollowupLimit"]);
  const safeFactClaimCorroborationFollowupLimit = factClaimCorroborationFollowupLimit === null || factClaimCorroborationFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(factClaimCorroborationFollowupLimit) || 0));
  const factClaimCorroborationPreview = factClaimCorroborationFollowups !== false && safeFactClaimCorroborationFollowupLimit > 0
    ? planSentimentFactClaimCorroborationJobs({
      days: Math.max(qualityDays, 30),
      limit: safeFactClaimCorroborationFollowupLimit,
      minConfidence: optionalBodyNumber(body, ["fact_claim_corroboration_min_confidence", "factClaimCorroborationMinConfidence", "fact_claim_corroboration_min_score", "factClaimCorroborationMinScore"]) ?? 45,
      maxTargetsPerClaim: optionalBodyNumber(body, ["fact_claim_corroboration_max_targets", "factClaimCorroborationMaxTargets", "fact_claim_corroboration_max_targets_per_claim", "factClaimCorroborationMaxTargetsPerClaim"]) ?? 3,
      searchSettings,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: factClaimCorroborationFollowups === false
        ? "fact-claim-corroboration-disabled"
        : "fact-claim-corroboration-limit-zero",
    };
  const alertEventFollowups = body.alert_event_followups ?? body.alertEventFollowups ?? true;
  const alertEventFollowupLimit = optionalBodyNumber(body, ["alert_event_followup_limit", "alertEventFollowupLimit"]);
  const safeAlertEventFollowupLimit = alertEventFollowupLimit === null || alertEventFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(alertEventFollowupLimit) || 0));
  const alertEventFollowupPreview = alertEventFollowups !== false && safeAlertEventFollowupLimit > 0
    ? planSentimentAlertEventFollowupJobs({
      limit: safeAlertEventFollowupLimit,
      minPriorityBoost: optionalBodyNumber(body, ["alert_event_followup_min_priority_boost", "alertEventFollowupMinPriorityBoost"]) ?? 24,
      cooldownHours: parseCooldownHours(body.alert_event_followup_cooldown_hours ?? body.alertEventFollowupCooldownHours, 6),
      searchSettings,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      signal_count: 0,
      reason: alertEventFollowups === false
        ? "alert-event-followups-disabled"
        : "alert-event-followup-limit-zero",
    };
  const sourceCoverageRefreshFollowups = body.source_coverage_refresh_followups ?? body.sourceCoverageRefreshFollowups ?? true;
  const keywordSourceFamilyCoverageFollowups = body.keyword_source_family_coverage_followups ?? body.keywordSourceFamilyCoverageFollowups ?? true;
  const keywordSourceFamilyCoverageFollowupLimit = optionalBodyNumber(body, ["keyword_source_family_coverage_followup_limit", "keywordSourceFamilyCoverageFollowupLimit"]);
  const safeKeywordSourceFamilyCoverageFollowupLimit = keywordSourceFamilyCoverageFollowupLimit === null || keywordSourceFamilyCoverageFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(keywordSourceFamilyCoverageFollowupLimit) || 0));
  const keywordSourceFamilyCoverageFollowupPreview = keywordSourceFamilyCoverageFollowups !== false && safeKeywordSourceFamilyCoverageFollowupLimit > 0
    ? planSentimentKeywordSourceFamilyCoverageFollowupJobs({
      days: Math.max(qualityDays, 30),
      limit: safeKeywordSourceFamilyCoverageFollowupLimit,
      minTotal: optionalBodyNumber(body, ["keyword_source_family_coverage_followup_min_total", "keywordSourceFamilyCoverageFollowupMinTotal"]) ?? 1,
      cooldownHours: parseCooldownHours(body.keyword_source_family_coverage_followup_cooldown_hours ?? body.keywordSourceFamilyCoverageFollowupCooldownHours, 12),
      searchSettings,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_gap_count: 0,
      reason: keywordSourceFamilyCoverageFollowups === false
        ? "keyword-source-family-coverage-followups-disabled"
        : "keyword-source-family-coverage-followup-limit-zero",
    };
  const eventClusterFollowups = body.event_cluster_followups ?? body.eventClusterFollowups ?? true;
  const eventClusterFollowupLimit = optionalBodyNumber(body, ["event_cluster_followup_limit", "eventClusterFollowupLimit"]);
  const safeEventClusterFollowupLimit = eventClusterFollowupLimit === null || eventClusterFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(eventClusterFollowupLimit) || 0));
  const eventClusterFollowupPreview = eventClusterFollowups !== false && safeEventClusterFollowupLimit > 0
    ? planSentimentEventClusterFollowupJobs({
      limit: safeEventClusterFollowupLimit,
      minPropagationScore: optionalBodyNumber(body, ["event_cluster_followup_min_propagation_score", "eventClusterFollowupMinPropagationScore"]) ?? 35,
      minPriorityBoost: optionalBodyNumber(body, ["event_cluster_followup_min_priority_boost", "eventClusterFollowupMinPriorityBoost"]) ?? 16,
      cooldownHours: parseCooldownHours(body.event_cluster_followup_cooldown_hours ?? body.eventClusterFollowupCooldownHours, 12),
      searchSettings,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_cluster_count: 0,
      reason: eventClusterFollowups === false
        ? "event-cluster-followups-disabled"
        : "event-cluster-followup-limit-zero",
    };
  const sourceCoverageRefreshFollowupLimit = optionalBodyNumber(body, ["source_coverage_refresh_followup_limit", "sourceCoverageRefreshFollowupLimit"]);
  const sourceCoverageRefreshSeedBaselinesWhenScanDisabled = optionalBoolean(
    body.source_coverage_refresh_seed_baselines_when_scan_disabled
      ?? body.sourceCoverageRefreshSeedBaselinesWhenScanDisabled,
    true,
  );
  const sourceCoverageRefreshSeedBaselineLimit = optionalBodyNumber(body, [
    "source_coverage_refresh_seed_baseline_limit",
    "sourceCoverageRefreshSeedBaselineLimit",
  ]);
  const sourceCoverageRefreshSeedBaselineBatches = optionalBodyNumber(body, [
    "source_coverage_refresh_seed_baseline_batches",
    "sourceCoverageRefreshSeedBaselineBatches",
    "source_coverage_refresh_seed_batches",
    "sourceCoverageRefreshSeedBatches",
  ]);
  const sourceCoverageRefreshSeedBaselinesOnly = scanSources === false
    && sourceCoverageRefreshSeedBaselinesWhenScanDisabled !== false
    && (sourceCoverageRefreshFollowupLimit === null || sourceCoverageRefreshFollowupLimit === undefined);
  const deferAsyncNoDataSourceCoverageSeedBaseline = body.async === true && sourceCoverageRefreshSeedBaselinesOnly;
  const safeSourceCoverageRefreshSeedBaselineLimit = sourceCoverageRefreshSeedBaselineLimit === null || sourceCoverageRefreshSeedBaselineLimit === undefined
    ? 6
    : Math.max(0, Math.min(20, Number(sourceCoverageRefreshSeedBaselineLimit) || 0));
  const safeSourceCoverageRefreshSeedBaselineBatches = sourceCoverageRefreshSeedBaselineBatches === null || sourceCoverageRefreshSeedBaselineBatches === undefined
    ? (sourceCoverageRefreshSeedBaselinesOnly && (sourceCoverageRefreshSeedBaselineLimit === null || sourceCoverageRefreshSeedBaselineLimit === undefined) ? 3 : 1)
    : Math.max(1, Math.min(5, Number(sourceCoverageRefreshSeedBaselineBatches) || 1));
  const sourceCoverageRefreshSeedBaselinePlanningLimit = sourceCoverageRefreshSeedBaselinesOnly
    ? Math.max(0, Math.min(50, safeSourceCoverageRefreshSeedBaselineLimit * safeSourceCoverageRefreshSeedBaselineBatches))
    : safeSourceCoverageRefreshSeedBaselineLimit;
  const safeSourceCoverageRefreshFollowupLimit = sourceCoverageRefreshFollowupLimit === null || sourceCoverageRefreshFollowupLimit === undefined
    ? (scanSources === false
      ? (sourceCoverageRefreshSeedBaselinesOnly ? Math.min(50, sourceCoverageRefreshSeedBaselinePlanningLimit) : 0)
      : Math.min(3, Math.max(1, Number(retryLimit) || 1)))
    : Math.max(0, Math.min(10, Number(sourceCoverageRefreshFollowupLimit) || 0));
  const sourceCoverageRefreshFollowupPreview = sourceCoverageRefreshFollowups !== false && safeSourceCoverageRefreshFollowupLimit > 0
    ? planSentimentSourceCoverageRefreshFollowupJobs({
      days: Math.max(qualityDays, 30),
      limit: safeSourceCoverageRefreshFollowupLimit,
      minCoverageScore: optionalBodyNumber(body, ["source_coverage_refresh_min_coverage_score", "sourceCoverageRefreshMinCoverageScore", "min_coverage_score", "minCoverageScore"]) ?? 70,
      seedBaselinesOnly: sourceCoverageRefreshSeedBaselinesOnly,
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      reason: sourceCoverageRefreshFollowups === false
        ? "source-coverage-refresh-followups-disabled"
        : "source-coverage-refresh-followup-limit-zero",
    };
  const historicalWindowBackfills = body.historical_window_backfills ?? body.historicalWindowBackfills ?? true;
  const historicalWindowBackfillLimit = optionalBodyNumber(body, ["historical_window_backfill_limit", "historicalWindowBackfillLimit"]);
  const safeHistoricalWindowBackfillLimit = historicalWindowBackfillLimit === null || historicalWindowBackfillLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(historicalWindowBackfillLimit) || 0));
  const historicalWindowBackfillPreview = historicalWindowBackfills !== false && safeHistoricalWindowBackfillLimit > 0
    ? planSentimentHistoricalWindowBackfillJobs({
      keywords: parseRouteKeywords(body),
      lookbackDays: parseSyncLimit(body.historical_window_backfill_lookback_days ?? body.historicalWindowBackfillLookbackDays, 365),
      windowDays: parseLimit(body.historical_window_backfill_window_days ?? body.historicalWindowBackfillWindowDays, 30),
      minRecentEvidence: parseNonNegativeLimit(body.historical_window_backfill_min_recent_evidence ?? body.historicalWindowBackfillMinRecentEvidence, 1),
      maxWindowEvidence: parseNonNegativeLimit(body.historical_window_backfill_max_window_evidence ?? body.historicalWindowBackfillMaxWindowEvidence, 0),
      maxWindowsPerKeyword: parseLimit(body.historical_window_backfill_max_windows_per_keyword ?? body.historicalWindowBackfillMaxWindowsPerKeyword, 2),
      maxSourcesPerWindow: parseLimit(body.historical_window_backfill_max_sources_per_window ?? body.historicalWindowBackfillMaxSourcesPerWindow, 2),
      sources: sources || [],
      limit: safeHistoricalWindowBackfillLimit,
      cooldownHours: parseCooldownHours(body.historical_window_backfill_cooldown_hours ?? body.historicalWindowBackfillCooldownHours, 24),
    })
    : {
      ok: true,
      layer_type: "historical-window-backfill",
      applied: false,
      jobs: [],
      job_count: 0,
      candidate_count: 0,
      summary: {
        keyword_count: 0,
        gap_window_count: 0,
        target_source_count: 0,
      },
      reason: historicalWindowBackfills === false
        ? "historical-window-backfills-disabled"
        : "historical-window-backfill-limit-zero",
    };
  const deepCrawlChainGapFollowups = body.deep_crawl_chain_gap_followups ?? body.deepCrawlChainGapFollowups ?? true;
  const deepCrawlChainGapFollowupLimit = optionalBodyNumber(body, ["deep_crawl_chain_gap_followup_limit", "deepCrawlChainGapFollowupLimit"]);
  const safeDeepCrawlChainGapFollowupLimit = deepCrawlChainGapFollowupLimit === null || deepCrawlChainGapFollowupLimit === undefined
    ? Math.min(2, Math.max(1, Number(retryLimit) || 1))
    : Math.max(0, Math.min(10, Number(deepCrawlChainGapFollowupLimit) || 0));
  const deepCrawlChainGapFollowupPreview = deepCrawlChainGapFollowups !== false && safeDeepCrawlChainGapFollowupLimit > 0
    ? planSentimentDeepCrawlChainGapFollowupJobs({
      days: Math.max(qualityDays, 30),
      limit: safeDeepCrawlChainGapFollowupLimit,
      keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || body.keyword || body.q || ""),
    })
    : {
      ok: true,
      applied: false,
      jobs: [],
      summary: {
        planned_jobs: 0,
        created_jobs: 0,
        skipped_running_jobs: 0,
      },
      reason: deepCrawlChainGapFollowups === false
        ? "deep-crawl-chain-gap-followups-disabled"
        : "deep-crawl-chain-gap-followup-limit-zero",
    };
  const collectionJobBacklogMaintenance = optionalBoolean(
    body.collection_job_backlog_maintenance
      ?? body.collectionJobBacklogMaintenance
      ?? body.backlog_maintenance
      ?? body.backlogMaintenance,
    true,
  );
  const collectionJobBacklogMaintenanceLimit = optionalBodyNumber(body, [
    "collection_job_backlog_maintenance_limit",
    "collectionJobBacklogMaintenanceLimit",
    "backlog_maintenance_limit",
    "backlogMaintenanceLimit",
  ]);
  const collectionJobBacklogMaintenanceRetryLimit = optionalBodyNumber(body, [
    "collection_job_backlog_maintenance_retry_limit",
    "collectionJobBacklogMaintenanceRetryLimit",
    "backlog_maintenance_retry_limit",
    "backlogMaintenanceRetryLimit",
  ]);
  const collectionJobBacklogExecutionLimit = optionalBodyNumber(body, [
    "collection_job_backlog_execution_limit",
    "collectionJobBacklogExecutionLimit",
    "backlog_execution_limit",
    "backlogExecutionLimit",
  ]);
  const collectionJobBacklogExecutionConcurrency = optionalBodyNumber(body, [
    "collection_job_backlog_execution_concurrency",
    "collectionJobBacklogExecutionConcurrency",
    "backlog_execution_concurrency",
    "backlogExecutionConcurrency",
  ]);
  const collectionJobBacklogDrainBatches = optionalBodyNumber(body, [
    "collection_job_backlog_drain_batches",
    "collectionJobBacklogDrainBatches",
    "backlog_drain_batches",
    "backlogDrainBatches",
  ]);
  const collectionJobBacklogMaintenancePreview = collectionJobBacklogMaintenance !== false
    ? maintainSentimentCollectionJobBacklog({
      apply: false,
      staleRunningLimit: collectionJobBacklogMaintenanceLimit === null || collectionJobBacklogMaintenanceLimit === undefined
        ? Math.min(10, Math.max(2, Number(retryLimit) || 3))
        : collectionJobBacklogMaintenanceLimit,
      retryLimit: collectionJobBacklogMaintenanceRetryLimit === null || collectionJobBacklogMaintenanceRetryLimit === undefined
        ? Math.min(10, Math.max(2, Number(retryLimit) || 3))
        : collectionJobBacklogMaintenanceRetryLimit,
      staleRunningMinutes: optionalBodyNumber(body, [
        "collection_job_backlog_maintenance_stale_running_minutes",
        "collectionJobBacklogMaintenanceStaleRunningMinutes",
        "stale_running_minutes",
        "staleRunningMinutes",
      ]) ?? 30,
      operator: "continuous-collection-dry-run",
      reason: "pre-retry-backlog-maintenance-preview",
    })
    : {
      ok: true,
      applied: false,
      summary: {
        stale_running_candidate_count: 0,
        recovered_stale_running_jobs: 0,
        retry_requeue_selected_count: 0,
        retry_requeue_job_count: 0,
      },
      reason: "collection-job-backlog-maintenance-disabled",
    };
  const wouldExecuteBacklogWork = Number(collectionJobBacklogMaintenancePreview.summary?.stale_running_candidate_count || 0)
    + Number(collectionJobBacklogMaintenancePreview.summary?.retry_requeue_selected_count || 0);
  const wouldExecuteBacklogLimit = collectionJobBacklogExecutionLimit === null || collectionJobBacklogExecutionLimit === undefined
    ? Math.min(12, Math.max(
      Number(retryLimit) || 3,
      wouldExecuteBacklogWork,
      wouldExecuteBacklogWork > 0 ? 6 : 0,
    ))
    : Math.max(0, Math.min(25, Number(collectionJobBacklogExecutionLimit) || 0));
  const wouldExecuteDuePendingBacklogCount = wouldExecuteBacklogLimit > 0
    ? listSentimentCollectionJobs({
      status: "pending",
      limit: Math.max(50, wouldExecuteBacklogLimit * 4),
      order: "due",
    }).filter(job => {
      const scheduledAt = new Date(job.scheduled_at || job.created_at || 0).getTime();
      return Number.isFinite(scheduledAt)
        && scheduledAt <= Date.now()
        && job.source_key !== "sourceDiscoveryDeepCrawl";
    }).length
    : 0;
  const wouldExecuteBacklogDrainBatches = collectionJobBacklogDrainBatches === null || collectionJobBacklogDrainBatches === undefined
    ? (wouldExecuteDuePendingBacklogCount > wouldExecuteBacklogLimit ? Math.min(3, Math.ceil(wouldExecuteDuePendingBacklogCount / Math.max(1, wouldExecuteBacklogLimit))) : 1)
    : Math.max(1, Math.min(5, Number(collectionJobBacklogDrainBatches) || 1));
  return {
    ok: true,
    dry_run: true,
    preview: true,
    mode,
    sourceScope: sources?.length ? "admin-settings" : "search-settings",
    requested_sources: sources || null,
    plan,
    ready_scan_sources: plan.ready_scan_sources || [],
    realtimeExpansionFollowupPreview,
    postScanRealtimeKeywordExpansionPreview,
    commercialQueryFanoutFollowupPreview,
    authorPivotFollowupPreview,
    authorReputationFollowupPreview,
    keywordRealtimeExpansionRouteFollowupPreview,
    openSearchArchiveFeedbackFollowupPreview,
    factClaimCorroborationPreview,
    alertEventFollowupPreview,
    keywordSourceFamilyCoverageFollowupPreview,
    eventClusterFollowupPreview,
    sourceCoverageRefreshFollowupPreview,
    historicalWindowBackfillPreview,
    deepCrawlChainGapFollowupPreview,
    collectionJobBacklogMaintenancePreview,
    would_execute: {
      collection_job_backlog_maintenance: collectionJobBacklogMaintenance,
      collection_job_backlog_maintenance_stale_running_jobs: collectionJobBacklogMaintenancePreview.summary?.stale_running_candidate_count || 0,
      collection_job_backlog_maintenance_retry_jobs: collectionJobBacklogMaintenancePreview.summary?.retry_requeue_selected_count || 0,
      collection_job_backlog_execution_limit: wouldExecuteBacklogLimit,
      collection_job_backlog_execution_concurrency: collectionJobBacklogExecutionConcurrency === null || collectionJobBacklogExecutionConcurrency === undefined
        ? ((wouldExecuteBacklogWork > 0 || wouldExecuteDuePendingBacklogCount > wouldExecuteBacklogLimit) ? Math.min(3, Math.max(1, wouldExecuteBacklogLimit)) : 1)
        : Math.max(1, Math.min(8, Number(collectionJobBacklogExecutionConcurrency) || 1)),
      collection_job_backlog_drain_batches: wouldExecuteBacklogDrainBatches,
      collection_job_backlog_due_pending_sample_count: wouldExecuteDuePendingBacklogCount,
      retry_limit: retryLimit,
      retry_jobs: optionalBoolean(body.retry_jobs ?? body.retryJobs ?? body.execute_retry_jobs ?? body.executeRetryJobs, true),
      retry_timeout_ms: Math.max(0, Math.min(15 * 60 * 1000, Number(optionalBodyNumber(body, ["retry_timeout_ms", "retryTimeoutMs", "retry_jobs_timeout_ms", "retryJobsTimeoutMs"]) || 0) || 0)),
      scan_sources: scanSources,
      scan_timeout_ms: Math.max(0, Math.min(15 * 60 * 1000, Number(optionalBodyNumber(body, ["scan_timeout_ms", "scanTimeoutMs", "timeout_ms", "timeoutMs"]) || 60_000) || 0)),
      defer_continuous_collection_execution: optionalBoolean(
        body.defer_continuous_collection_execution
          ?? body.deferContinuousCollectionExecution,
        body.async === true
          && sourceCoverageRefreshSeedBaselinesOnly
          && typeof ctx.startBackgroundContinuousCollection !== "function",
      ),
      source_coverage_refresh_timeout_ms: Math.max(0, Math.min(15 * 60 * 1000, Number(optionalBodyNumber(body, ["source_coverage_refresh_timeout_ms", "sourceCoverageRefreshTimeoutMs", "source_coverage_timeout_ms", "sourceCoverageTimeoutMs"]) || 120_000) || 0)),
      search_index_maintenance: optionalBoolean(body.search_index_maintenance ?? body.searchIndexMaintenance, true),
      search_index_maintenance_limit: parseSyncLimit(body.search_index_maintenance_limit ?? body.searchIndexMaintenanceLimit, 1000),
      search_index_maintenance_auto_rebuild: optionalBoolean(body.search_index_maintenance_auto_rebuild ?? body.searchIndexMaintenanceAutoRebuild, false),
      opensearch_archive_sync: optionalBoolean(body.opensearch_archive_sync ?? body.openSearchArchiveSync, true),
      opensearch_archive_sync_limit: parseSyncLimit(body.opensearch_archive_sync_limit ?? body.openSearchArchiveSyncLimit, readSentimentSearchSettings(pluginCtx(c).config)?.openSearch?.maxSyncItems || 1000),
      opensearch_archive_sync_dry_run: optionalBoolean(body.opensearch_archive_sync_dry_run ?? body.openSearchArchiveSyncDryRun, false),
      opensearch_archive_maintenance: optionalBoolean(body.opensearch_archive_maintenance ?? body.openSearchArchiveMaintenance, true),
      opensearch_archive_maintenance_dry_run: optionalBoolean(body.opensearch_archive_maintenance_dry_run ?? body.openSearchArchiveMaintenanceDryRun, true),
      opensearch_archive_outbox: optionalBoolean(body.opensearch_archive_outbox ?? body.openSearchArchiveOutbox, true),
      opensearch_archive_outbox_replay: optionalBoolean(body.opensearch_archive_outbox_replay ?? body.openSearchArchiveOutboxReplay, true),
      opensearch_archive_outbox_replay_limit: parseSyncLimit(body.opensearch_archive_outbox_replay_limit ?? body.openSearchArchiveOutboxReplayLimit, 100),
      ready_scan_source_count: (plan.ready_scan_sources || []).length,
      realtime_expansion_followup_jobs: realtimeExpansionFollowupPreview.job_count || 0,
      post_scan_realtime_keyword_expansion_jobs: postScanRealtimeKeywordExpansionPreview.job_count || 0,
      commercial_query_fanout_followup_jobs: commercialQueryFanoutFollowupPreview.job_count || 0,
      author_pivot_followup_jobs: authorPivotFollowupPreview.job_count || 0,
      author_reputation_followup_jobs: authorReputationFollowupPreview.job_count || 0,
      keyword_realtime_expansion_route_followup_jobs: keywordRealtimeExpansionRouteFollowupPreview.job_count || 0,
      opensearch_archive_feedback_followup_jobs: openSearchArchiveFeedbackFollowupPreview.job_count || 0,
      fact_claim_corroboration_jobs: factClaimCorroborationPreview.job_count || 0,
      alert_event_followup_jobs: alertEventFollowupPreview.job_count || 0,
      keyword_source_family_coverage_followup_jobs: keywordSourceFamilyCoverageFollowupPreview.job_count || 0,
      event_cluster_followup_jobs: eventClusterFollowupPreview.job_count || 0,
      source_coverage_refresh_followup_jobs: sourceCoverageRefreshFollowupPreview.job_count || 0,
      source_coverage_refresh_execute: optionalBoolean(
        body.source_coverage_refresh_execute
          ?? body.sourceCoverageRefreshExecute
          ?? body.execute_source_coverage_refresh_followups
          ?? body.executeSourceCoverageRefreshFollowups,
        !(body.async === true && scanSources === false),
      ),
      source_coverage_refresh_seed_baseline_batches: safeSourceCoverageRefreshSeedBaselineBatches,
      source_coverage_refresh_seed_baseline_execution_limit: Math.max(1, Math.min(6, safeSourceCoverageRefreshSeedBaselineLimit)),
      historical_window_backfill_jobs: historicalWindowBackfillPreview.job_count || 0,
      deep_crawl_chain_gap_followup_jobs: deepCrawlChainGapFollowupPreview.summary?.planned_jobs || deepCrawlChainGapFollowupPreview.job_count || 0,
    },
  };
}

function continuousCollectionRunOptionsForRoute(c, body = {}) {
  const ctx = pluginCtx(c);
  const mode = routeScanMode(body.mode || body.scanMode || body.scan_mode || "fast");
  const sources = configuredSourceScopeForMode(c, mode);
  const scanSources = optionalBoolean(body.scan_sources ?? body.scanSources ?? body.execute_scan ?? body.executeScan, true);
  const sourceCoverageRefreshFollowupLimit = optionalBodyNumber(body, ["source_coverage_refresh_followup_limit", "sourceCoverageRefreshFollowupLimit"]);
  const sourceCoverageRefreshSeedBaselineLimit = optionalBodyNumber(body, [
    "source_coverage_refresh_seed_baseline_limit",
    "sourceCoverageRefreshSeedBaselineLimit",
  ]);
  const sourceCoverageRefreshSeedBaselineBatches = optionalBodyNumber(body, [
    "source_coverage_refresh_seed_baseline_batches",
    "sourceCoverageRefreshSeedBaselineBatches",
    "source_coverage_refresh_seed_batches",
    "sourceCoverageRefreshSeedBatches",
  ]);
  const sourceCoverageRefreshSeedBaselinesWhenScanDisabled = optionalBoolean(
    body.source_coverage_refresh_seed_baselines_when_scan_disabled
      ?? body.sourceCoverageRefreshSeedBaselinesWhenScanDisabled,
    true,
  );
  const sourceCoverageRefreshSeedBaselinesOnly = scanSources === false
    && sourceCoverageRefreshSeedBaselinesWhenScanDisabled !== false
    && (sourceCoverageRefreshFollowupLimit === null || sourceCoverageRefreshFollowupLimit === undefined);
  const hasExternalContinuousCollectionWorker = typeof ctx.startBackgroundContinuousCollection === "function";
  const deferAsyncNoDataSourceCoverageSeedBaseline = body.async === true
    && sourceCoverageRefreshSeedBaselinesOnly
    && !hasExternalContinuousCollectionWorker;
  const freeSourceTargetCoverageFollowupLimit = optionalBodyNumber(body, ["free_source_target_coverage_followup_limit", "freeSourceTargetCoverageFollowupLimit"]);
  const historicalWindowBackfillLimit = optionalBodyNumber(body, ["historical_window_backfill_limit", "historicalWindowBackfillLimit"]);
  return {
    options: {
      mode,
      maxSources: parseLimit(body.max_sources || body.maxSources, 8),
      retryLimit: parseLimit(body.retry_limit || body.retryLimit, 3),
      realtimeExpansionFollowups: body.realtime_expansion_followups ?? body.realtimeExpansionFollowups ?? true,
      realtimeExpansionFollowupLimit: optionalBodyNumber(body, ["realtime_expansion_followup_limit", "realtimeExpansionFollowupLimit", "realtime_keyword_expansion_followup_limit", "realtimeKeywordExpansionFollowupLimit"]),
      postScanRealtimeExpansionFollowupLimit: optionalBodyNumber(body, ["post_scan_realtime_expansion_followup_limit", "postScanRealtimeExpansionFollowupLimit", "post_scan_realtime_keyword_expansion_followup_limit", "postScanRealtimeKeywordExpansionFollowupLimit"]),
      realtimeExpansionFollowupMinScore: optionalBodyNumber(body, ["realtime_expansion_followup_min_score", "realtimeExpansionFollowupMinScore", "realtime_keyword_expansion_followup_min_score", "realtimeKeywordExpansionFollowupMinScore"]) ?? 45,
      realtimeExpansionFollowupMinResultCount: optionalBodyNumber(body, ["realtime_expansion_followup_min_result_count", "realtimeExpansionFollowupMinResultCount", "realtime_keyword_expansion_followup_min_result_count", "realtimeKeywordExpansionFollowupMinResultCount"]) ?? 1,
      postScanRealtimeKeywordExpansionFollowups: body.post_scan_realtime_keyword_expansion_followups ?? body.postScanRealtimeKeywordExpansionFollowups ?? true,
      postScanRealtimeKeywordExpansionFollowupLimit: optionalBodyNumber(body, ["post_scan_realtime_keyword_expansion_followup_limit", "postScanRealtimeKeywordExpansionFollowupLimit"]),
      postScanRealtimeKeywordExpansionFollowupMinScore: optionalBodyNumber(body, ["post_scan_realtime_keyword_expansion_min_score", "postScanRealtimeKeywordExpansionMinScore"]) ?? 45,
      postScanRealtimeKeywordExpansionMaxSourcesPerCandidate: optionalBodyNumber(body, ["post_scan_realtime_keyword_expansion_max_sources_per_candidate", "postScanRealtimeKeywordExpansionMaxSourcesPerCandidate"]) ?? 3,
      commercialQueryFanoutFollowups: body.commercial_query_fanout_followups ?? body.commercialQueryFanoutFollowups ?? true,
      commercialQueryFanoutFollowupLimit: optionalBodyNumber(body, ["commercial_query_fanout_followup_limit", "commercialQueryFanoutFollowupLimit"]),
      commercialQueryFanoutFollowupMinScore: optionalBodyNumber(body, ["commercial_query_fanout_followup_min_score", "commercialQueryFanoutFollowupMinScore"]) ?? 55,
      commercialQueryFanoutFollowupMinEvidence: optionalBodyNumber(body, ["commercial_query_fanout_followup_min_evidence", "commercialQueryFanoutFollowupMinEvidence"]) ?? 1,
      commercialQueryFanoutFollowupIncludeWatch: optionalBoolean(body.commercial_query_fanout_followup_include_watch ?? body.commercialQueryFanoutFollowupIncludeWatch, false),
      authorPivotFollowups: body.author_pivot_followups ?? body.authorPivotFollowups ?? true,
      authorPivotFollowupLimit: optionalBodyNumber(body, ["author_pivot_followup_limit", "authorPivotFollowupLimit"]),
      authorPivotFollowupMinMentions: optionalBodyNumber(body, ["author_pivot_min_mentions", "authorPivotMinMentions", "author_pivot_followup_min_mentions", "authorPivotFollowupMinMentions"]) ?? 2,
      authorPivotFollowupMinHighRisk: optionalBodyNumber(body, ["author_pivot_min_high_risk", "authorPivotMinHighRisk", "author_pivot_followup_min_high_risk", "authorPivotFollowupMinHighRisk"]) ?? 1,
      authorPivotFollowupMaxSourcesPerAuthor: optionalBodyNumber(body, ["author_pivot_max_sources_per_author", "authorPivotMaxSourcesPerAuthor", "author_pivot_followup_max_sources_per_author", "authorPivotFollowupMaxSourcesPerAuthor"]) ?? 3,
      authorPivotFollowupCooldownHours: parseCooldownHours(body.author_pivot_followup_cooldown_hours ?? body.authorPivotFollowupCooldownHours, 12),
      authorReputationFollowups: body.author_reputation_followups ?? body.authorReputationFollowups ?? true,
      authorReputationFollowupLimit: optionalBodyNumber(body, ["author_reputation_followup_limit", "authorReputationFollowupLimit"]),
      authorReputationFollowupMinCoordinationRisk: optionalBodyNumber(body, ["author_reputation_min_coordination_risk", "authorReputationMinCoordinationRisk", "author_reputation_followup_min_coordination_risk", "authorReputationFollowupMinCoordinationRisk"]) ?? 55,
      authorReputationFollowupMinHighRisk: optionalBodyNumber(body, ["author_reputation_min_high_risk", "authorReputationMinHighRisk", "author_reputation_followup_min_high_risk", "authorReputationFollowupMinHighRisk"]) ?? 1,
      authorReputationFollowupMaxReputationScore: optionalBodyNumber(body, ["author_reputation_max_reputation_score", "authorReputationMaxReputationScore", "author_reputation_followup_max_reputation_score", "authorReputationFollowupMaxReputationScore"]) ?? 45,
      authorReputationFollowupCooldownHours: parseCooldownHours(body.author_reputation_followup_cooldown_hours ?? body.authorReputationFollowupCooldownHours, 12),
      keywordRealtimeExpansionRouteFollowups: body.keyword_realtime_expansion_route_followups ?? body.keywordRealtimeExpansionRouteFollowups ?? true,
      keywordRealtimeExpansionRouteFollowupLimit: optionalBodyNumber(body, ["keyword_realtime_expansion_route_followup_limit", "keywordRealtimeExpansionRouteFollowupLimit"]),
      keywordRealtimeExpansionRouteMaxSourcesPerPack: optionalBodyNumber(body, ["keyword_realtime_expansion_route_max_sources_per_pack", "keywordRealtimeExpansionRouteMaxSourcesPerPack"]) ?? 2,
      keywordRealtimeExpansionRouteMaxKeywordsPerJob: optionalBodyNumber(body, ["keyword_realtime_expansion_route_max_keywords_per_job", "keywordRealtimeExpansionRouteMaxKeywordsPerJob"]) ?? 6,
      keywordRealtimeExpansionRouteMinCandidateScore: optionalBodyNumber(body, ["keyword_realtime_expansion_route_min_candidate_score", "keywordRealtimeExpansionRouteMinCandidateScore"]) ?? 0,
      openSearchArchiveFeedbackFollowups: body.opensearch_archive_feedback_followups ?? body.openSearchArchiveFeedbackFollowups ?? true,
      openSearchArchiveFeedbackFollowupLimit: optionalBodyNumber(body, ["opensearch_archive_feedback_followup_limit", "openSearchArchiveFeedbackFollowupLimit", "opensearchArchiveFeedbackFollowupLimit"]),
      openSearchArchiveFeedbackFollowupMinScore: optionalBodyNumber(body, ["opensearch_archive_feedback_followup_min_score", "openSearchArchiveFeedbackFollowupMinScore", "opensearchArchiveFeedbackFollowupMinScore", "min_archive_score", "minArchiveScore"]) ?? 60,
      factClaimCorroborationFollowups: body.fact_claim_corroboration_followups ?? body.factClaimCorroborationFollowups ?? true,
      factClaimCorroborationFollowupLimit: optionalBodyNumber(body, ["fact_claim_corroboration_followup_limit", "factClaimCorroborationFollowupLimit"]),
      factClaimCorroborationFollowupMinConfidence: optionalBodyNumber(body, ["fact_claim_corroboration_min_confidence", "factClaimCorroborationMinConfidence", "fact_claim_corroboration_min_score", "factClaimCorroborationMinScore"]) ?? 45,
      factClaimCorroborationMaxTargets: optionalBodyNumber(body, ["fact_claim_corroboration_max_targets", "factClaimCorroborationMaxTargets", "fact_claim_corroboration_max_targets_per_claim", "factClaimCorroborationMaxTargetsPerClaim"]) ?? 3,
      alertEventFollowups: body.alert_event_followups ?? body.alertEventFollowups ?? true,
      alertEventFollowupLimit: optionalBodyNumber(body, ["alert_event_followup_limit", "alertEventFollowupLimit"]),
      alertEventFollowupMinPriorityBoost: optionalBodyNumber(body, ["alert_event_followup_min_priority_boost", "alertEventFollowupMinPriorityBoost"]) ?? 24,
      alertEventFollowupCooldownHours: parseCooldownHours(body.alert_event_followup_cooldown_hours ?? body.alertEventFollowupCooldownHours, 6),
      sourceFailurePersistentRecoveryFollowups: body.source_failure_persistent_recovery_followups ?? body.sourceFailurePersistentRecoveryFollowups ?? true,
      sourceFailurePersistentRecoveryFollowupLimit: optionalBodyNumber(body, ["source_failure_persistent_recovery_followup_limit", "sourceFailurePersistentRecoveryFollowupLimit"]),
      sourceFailurePersistentRecoveryMinFailureCount: optionalBodyNumber(body, ["source_failure_persistent_recovery_min_failure_count", "sourceFailurePersistentRecoveryMinFailureCount"]) ?? 1,
      sourceFailurePersistentRecoveryMinZeroResultCount: optionalBodyNumber(body, ["source_failure_persistent_recovery_min_zero_result_count", "sourceFailurePersistentRecoveryMinZeroResultCount"]) ?? 2,
      sourceFailurePersistentRecoveryCooldownHours: parseCooldownHours(body.source_failure_persistent_recovery_cooldown_hours ?? body.sourceFailurePersistentRecoveryCooldownHours, 6),
      keywordSourceFamilyCoverageFollowups: body.keyword_source_family_coverage_followups ?? body.keywordSourceFamilyCoverageFollowups ?? true,
      keywordSourceFamilyCoverageFollowupLimit: optionalBodyNumber(body, ["keyword_source_family_coverage_followup_limit", "keywordSourceFamilyCoverageFollowupLimit"]),
      keywordSourceFamilyCoverageFollowupMinTotal: optionalBodyNumber(body, ["keyword_source_family_coverage_followup_min_total", "keywordSourceFamilyCoverageFollowupMinTotal"]) ?? 1,
      keywordSourceFamilyCoverageFollowupCooldownHours: parseCooldownHours(body.keyword_source_family_coverage_followup_cooldown_hours ?? body.keywordSourceFamilyCoverageFollowupCooldownHours, 12),
      eventClusterFollowups: body.event_cluster_followups ?? body.eventClusterFollowups ?? true,
      eventClusterFollowupLimit: optionalBodyNumber(body, ["event_cluster_followup_limit", "eventClusterFollowupLimit"]),
      eventClusterFollowupMinPropagationScore: optionalBodyNumber(body, ["event_cluster_followup_min_propagation_score", "eventClusterFollowupMinPropagationScore"]) ?? 35,
      eventClusterFollowupMinPriorityBoost: optionalBodyNumber(body, ["event_cluster_followup_min_priority_boost", "eventClusterFollowupMinPriorityBoost"]) ?? 16,
      eventClusterFollowupCooldownHours: parseCooldownHours(body.event_cluster_followup_cooldown_hours ?? body.eventClusterFollowupCooldownHours, 12),
      sourceCoverageRefreshFollowups: body.source_coverage_refresh_followups ?? body.sourceCoverageRefreshFollowups ?? true,
      sourceCoverageRefreshFollowupLimit: sourceCoverageRefreshFollowupLimit === null || sourceCoverageRefreshFollowupLimit === undefined
        ? null
        : sourceCoverageRefreshFollowupLimit,
      sourceCoverageRefreshFollowupMinCoverageScore: optionalBodyNumber(body, ["source_coverage_refresh_min_coverage_score", "sourceCoverageRefreshMinCoverageScore", "min_coverage_score", "minCoverageScore"]) ?? 70,
      sourceCoverageRefreshExecute: optionalBoolean(
        body.source_coverage_refresh_execute
          ?? body.sourceCoverageRefreshExecute
          ?? body.execute_source_coverage_refresh_followups
          ?? body.executeSourceCoverageRefreshFollowups,
        !(body.async === true && scanSources === false),
      ),
      sourceCoverageRefreshSeedBaselinesWhenScanDisabled: optionalBoolean(
        body.source_coverage_refresh_seed_baselines_when_scan_disabled
          ?? body.sourceCoverageRefreshSeedBaselinesWhenScanDisabled,
        true,
      ),
      sourceCoverageRefreshSeedBaselineLimit,
      sourceCoverageRefreshSeedBaselineBatches,
      deferContinuousCollectionExecution: optionalBoolean(
        body.defer_continuous_collection_execution
          ?? body.deferContinuousCollectionExecution,
        deferAsyncNoDataSourceCoverageSeedBaseline,
      ),
      deferContinuousCollectionReason: String(
        body.defer_continuous_collection_reason
          || body.deferContinuousCollectionReason
          || (deferAsyncNoDataSourceCoverageSeedBaseline
            ? "async-no-data-source-coverage-seed-baseline-deferred-from-web-process"
            : "")
      ).slice(0, 240),
      freeSourceTargetCoverageFollowups: body.free_source_target_coverage_followups ?? body.freeSourceTargetCoverageFollowups ?? true,
      freeSourceTargetCoverageFollowupLimit: freeSourceTargetCoverageFollowupLimit === null || freeSourceTargetCoverageFollowupLimit === undefined
        ? (scanSources === false ? 0 : null)
        : freeSourceTargetCoverageFollowupLimit,
      historicalWindowBackfills: body.historical_window_backfills ?? body.historicalWindowBackfills ?? true,
      historicalWindowBackfillLimit: historicalWindowBackfillLimit === null || historicalWindowBackfillLimit === undefined
        ? null
        : historicalWindowBackfillLimit,
      historicalWindowBackfillLookbackDays: parseSyncLimit(body.historical_window_backfill_lookback_days ?? body.historicalWindowBackfillLookbackDays, 365),
      historicalWindowBackfillWindowDays: parseLimit(body.historical_window_backfill_window_days ?? body.historicalWindowBackfillWindowDays, 30),
      historicalWindowBackfillMinRecentEvidence: parseNonNegativeLimit(body.historical_window_backfill_min_recent_evidence ?? body.historicalWindowBackfillMinRecentEvidence, 1),
      historicalWindowBackfillMaxWindowEvidence: parseNonNegativeLimit(body.historical_window_backfill_max_window_evidence ?? body.historicalWindowBackfillMaxWindowEvidence, 0),
      historicalWindowBackfillMaxWindowsPerKeyword: parseLimit(body.historical_window_backfill_max_windows_per_keyword ?? body.historicalWindowBackfillMaxWindowsPerKeyword, 2),
      historicalWindowBackfillMaxSourcesPerWindow: parseLimit(body.historical_window_backfill_max_sources_per_window ?? body.historicalWindowBackfillMaxSourcesPerWindow, 2),
      historicalWindowBackfillCooldownHours: parseCooldownHours(body.historical_window_backfill_cooldown_hours ?? body.historicalWindowBackfillCooldownHours, 24),
      deepCrawlChainGapFollowups: body.deep_crawl_chain_gap_followups ?? body.deepCrawlChainGapFollowups ?? true,
      deepCrawlChainGapFollowupLimit: optionalBodyNumber(body, ["deep_crawl_chain_gap_followup_limit", "deepCrawlChainGapFollowupLimit"]),
      collectionJobBacklogMaintenance: optionalBoolean(
        body.collection_job_backlog_maintenance
          ?? body.collectionJobBacklogMaintenance
          ?? body.backlog_maintenance
          ?? body.backlogMaintenance,
        true,
      ),
      collectionJobBacklogMaintenanceLimit: optionalBodyNumber(body, [
        "collection_job_backlog_maintenance_limit",
        "collectionJobBacklogMaintenanceLimit",
        "backlog_maintenance_limit",
        "backlogMaintenanceLimit",
      ]),
      collectionJobBacklogMaintenanceRetryLimit: optionalBodyNumber(body, [
        "collection_job_backlog_maintenance_retry_limit",
        "collectionJobBacklogMaintenanceRetryLimit",
        "backlog_maintenance_retry_limit",
        "backlogMaintenanceRetryLimit",
      ]),
      collectionJobBacklogExecutionLimit: optionalBodyNumber(body, [
        "collection_job_backlog_execution_limit",
        "collectionJobBacklogExecutionLimit",
        "backlog_execution_limit",
        "backlogExecutionLimit",
      ]),
      collectionJobBacklogExecutionConcurrency: optionalBodyNumber(body, [
        "collection_job_backlog_execution_concurrency",
        "collectionJobBacklogExecutionConcurrency",
        "backlog_execution_concurrency",
        "backlogExecutionConcurrency",
      ]),
      collectionJobBacklogDrainBatches: optionalBodyNumber(body, [
        "collection_job_backlog_drain_batches",
        "collectionJobBacklogDrainBatches",
        "backlog_drain_batches",
        "backlogDrainBatches",
      ]),
      collectionJobBacklogMaintenanceStaleRunningMinutes: optionalBodyNumber(body, [
        "collection_job_backlog_maintenance_stale_running_minutes",
        "collectionJobBacklogMaintenanceStaleRunningMinutes",
        "stale_running_minutes",
        "staleRunningMinutes",
      ]) ?? 30,
      retryJobs: optionalBoolean(body.retry_jobs ?? body.retryJobs ?? body.execute_retry_jobs ?? body.executeRetryJobs, true),
      retryTimeoutMs: optionalBodyNumber(body, ["retry_timeout_ms", "retryTimeoutMs", "retry_jobs_timeout_ms", "retryJobsTimeoutMs"]) ?? 0,
      scanSources,
      scanTimeoutMs: optionalBodyNumber(body, ["scan_timeout_ms", "scanTimeoutMs", "timeout_ms", "timeoutMs"]) ?? 60_000,
      sourceCoverageRefreshTimeoutMs: optionalBodyNumber(body, [
        "source_coverage_refresh_timeout_ms",
        "sourceCoverageRefreshTimeoutMs",
        "source_coverage_timeout_ms",
        "sourceCoverageTimeoutMs",
      ]) ?? 120_000,
      searchIndexMaintenance: optionalBoolean(body.search_index_maintenance ?? body.searchIndexMaintenance, true),
      searchIndexMaintenanceLimit: parseSyncLimit(body.search_index_maintenance_limit ?? body.searchIndexMaintenanceLimit, 1000),
      searchIndexMaintenanceAutoRebuild: optionalBoolean(body.search_index_maintenance_auto_rebuild ?? body.searchIndexMaintenanceAutoRebuild, false),
      openSearchArchiveSync: optionalBoolean(body.opensearch_archive_sync ?? body.openSearchArchiveSync, true),
      openSearchArchiveSyncLimit: parseSyncLimit(body.opensearch_archive_sync_limit ?? body.openSearchArchiveSyncLimit, readSentimentSearchSettings(pluginCtx(c).config)?.openSearch?.maxSyncItems || 1000),
      openSearchArchiveSyncDryRun: optionalBoolean(body.opensearch_archive_sync_dry_run ?? body.openSearchArchiveSyncDryRun, false),
      openSearchArchiveMaintenance: optionalBoolean(body.opensearch_archive_maintenance ?? body.openSearchArchiveMaintenance, true),
      openSearchArchiveMaintenanceDryRun: optionalBoolean(body.opensearch_archive_maintenance_dry_run ?? body.openSearchArchiveMaintenanceDryRun, true),
      openSearchArchiveOutbox: optionalBoolean(body.opensearch_archive_outbox ?? body.openSearchArchiveOutbox, true),
      openSearchArchiveOutboxReplay: optionalBoolean(body.opensearch_archive_outbox_replay ?? body.openSearchArchiveOutboxReplay, true),
      openSearchArchiveOutboxReplayLimit: parseSyncLimit(body.opensearch_archive_outbox_replay_limit ?? body.openSearchArchiveOutboxReplayLimit, 100),
      postScanFollowupLimit: optionalBodyNumber(body, ["post_scan_followup_limit", "postScanFollowupLimit", "post_scan_evidence_followup_limit", "postScanEvidenceFollowupLimit"]),
      discoveryDeepCrawl: body.discovery_deep_crawl ?? body.discoveryDeepCrawl ?? true,
      discoveryDeepCrawlLimit: parseLimit(body.discovery_deep_crawl_limit || body.discoveryDeepCrawlLimit, 3),
      discoveryDeepCrawlFollowupLimit: optionalBodyNumber(body, ["discovery_deep_crawl_followup_limit", "discoveryDeepCrawlFollowupLimit", "followup_limit", "followupLimit"]),
      searchSettings: routeSearchSettingsWithSources(c, sources),
    },
    routeMeta: {
      mode,
      sourceScope: sources?.length ? "admin-settings" : "search-settings",
      requested_sources: sources || null,
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergePlainSettings(base = {}, override = {}) {
  if (!isPlainObject(override)) return base;
  const out = { ...(isPlainObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergePlainSettings(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
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

// GET /api/plugins/sentiment/sentiment/collection-jobs/keyword-source-family-coverage-followups
app.get("/collection-jobs/keyword-source-family-coverage-followups", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(planSentimentKeywordSourceFamilyCoverageFollowupJobs({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minTotal: parseLimit(c.req.query("min_total") || c.req.query("minTotal"), 1),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    searchSettings,
  }));
});

// POST /api/plugins/sentiment/sentiment/collection-jobs/keyword-source-family-coverage-followups
app.post("/collection-jobs/keyword-source-family-coverage-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentKeywordSourceFamilyCoverageFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minTotal: parseLimit(body.min_total || body.minTotal, 1),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    searchSettings,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

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
  const useFastSummary = optionalBoolean(c.req.query("fast_summary") ?? c.req.query("fastSummary") ?? c.req.query("summary_only") ?? c.req.query("summaryOnly"), false);
  const reportOptions = {
    mode,
    searchSettings: routeSearchSettingsWithSources(c, sources),
    maxSources: parseLimit(c.req.query("max_sources") || c.req.query("maxSources"), 8),
    retryLimit: parseLimit(c.req.query("retry_limit") || c.req.query("retryLimit"), 20),
    staleMultiplier: parseLimit(c.req.query("stale_multiplier") || c.req.query("staleMultiplier"), 3),
    includeJobDetails: optionalBoolean(c.req.query("include_job_details") ?? c.req.query("includeJobDetails"), false),
    includeSourceDetails: optionalBoolean(c.req.query("include_source_details") ?? c.req.query("includeSourceDetails"), false),
    includePlanDetails: optionalBoolean(c.req.query("include_plan_details") ?? c.req.query("includePlanDetails"), false),
  };
  const report = useFastSummary
    ? getSentimentCollectionOperationsFastReport(reportOptions)
    : getSentimentCollectionOperationsReport(reportOptions);
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

// GET /api/plugins/sentiment/sentiment/collection-quality/realtime-keyword-expansion
app.get("/collection-quality/realtime-keyword-expansion", (c) => c.json(listSentimentRealtimeKeywordExpansionEffectiveness({
  days: parseLimit(c.req.query("days"), 30),
  limit: parseLimit(c.req.query("limit"), 50),
  minSamples: parseLimit(c.req.query("min_samples") || c.req.query("minSamples"), 1),
})));

// GET /api/plugins/sentiment/sentiment/collection-quality/opensearch-archive-feedback
app.get("/collection-quality/opensearch-archive-feedback", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minArchiveScore = c.req.query("min_archive_score") || c.req.query("minArchiveScore") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(getSentimentOpenSearchArchiveFeedbackReport({
    days: parseLimit(c.req.query("days"), 30),
    limit: parseLimit(c.req.query("limit"), 100),
    minArchiveScore: minArchiveScore === undefined || minArchiveScore === null || minArchiveScore === "" ? null : parseLimit(minArchiveScore, searchSettings.openSearch?.minArchiveScore || 60),
    searchSettings,
  }));
});

// GET /api/plugins/sentiment/sentiment/keyword-expansion/realtime-layer
app.get("/keyword-expansion/realtime-layer", (c) => c.json(getSentimentRealtimeKeywordExpansionLayerReport({
  days: parseLimit(c.req.query("days"), 30),
  limit: parseLimit(c.req.query("limit"), 50),
})));

// GET /api/plugins/sentiment/sentiment/keyword-expansion/realtime-layer/plan
app.get("/keyword-expansion/realtime-layer/plan", async (c) => {
  const ctx = pluginCtx(c);
  const baseSearchSettings = readSentimentSearchSettings(ctx.config);
  const aiSettings = readSentimentAiSettings(ctx.config);
  return c.json(await planSentimentKeywordRealtimeExpansionLayer({
    keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
    mode: c.req.query("mode") || "fast",
    searchSettings: baseSearchSettings,
    aiSettings,
    existingKeywords: parseCsvQuery(c.req.query("existing_keywords") || c.req.query("existingKeywords") || ""),
    limit: parseLimit(c.req.query("limit"), 80),
    candidateLimit: parseLimit(c.req.query("candidate_limit") || c.req.query("candidateLimit"), 80),
    forceRefresh: c.req.query("force") === "1" || c.req.query("force_refresh") === "1",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/multilingual-query-effectiveness
app.get("/collection-jobs/multilingual-query-effectiveness", (c) => c.json(getSentimentMultilingualQueryEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/continuous-collection/run
app.post("/continuous-collection/run", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (optionalBoolean(body.dry_run ?? body.dryRun ?? body.preview, false)) {
    return c.json(await continuousCollectionPreviewForRoute(c, body));
  }
  const { options, routeMeta } = continuousCollectionRunOptionsForRoute(c, body);
  if (optionalBoolean(body.async ?? body.asyncRun ?? body.background ?? body.backgroundRun, false)) {
    const ctx = pluginCtx(c);
    const allowConcurrent = optionalBoolean(body.allow_concurrent ?? body.allowConcurrent, false);
    const started = typeof ctx.startBackgroundContinuousCollection === "function"
      ? ctx.startBackgroundContinuousCollection({
        options,
        allowConcurrent,
      })
      : startSentimentContinuousCollectionRun({
        ...options,
        allowConcurrent,
      });
    return c.json({
      ...started,
      ...routeMeta,
      run_id: started.run?.id || null,
      poll_url: started.run?.id ? `/api/plugins/sentiment/sentiment/continuous-collection/runs/${started.run.id}` : null,
    }, 202);
  }
  const result = await executeSentimentContinuousCollectionCycle(options);
  return c.json({
    ...result,
    ...routeMeta,
  });
});

// GET /api/plugins/sentiment/sentiment/continuous-collection/runs
app.get("/continuous-collection/runs", (c) => {
  const limit = parseLimit(c.req.query("limit"), 20);
  const local = listSentimentContinuousCollectionRuns({ limit });
  const ctx = pluginCtx(c);
  if (typeof ctx.listBackgroundContinuousCollectionRuns !== "function") return c.json(local);
  const external = ctx.listBackgroundContinuousCollectionRuns({ limit });
  const unique = new Map();
  for (const run of [...(local.runs || []), ...(external.runs || [])]) {
    if (!run?.id || unique.has(run.id)) continue;
    unique.set(run.id, run);
  }
  return c.json({
    ok: true,
    runs: [...unique.values()]
      .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
      .slice(0, limit),
  });
});

// GET /api/plugins/sentiment/sentiment/continuous-collection/runs/:id
app.get("/continuous-collection/runs/:id", (c) => {
  const ctx = pluginCtx(c);
  let result = getSentimentContinuousCollectionRun(c.req.param("id"));
  if (!result.ok && typeof ctx.getBackgroundContinuousCollectionRun === "function") {
    result = ctx.getBackgroundContinuousCollectionRun(c.req.param("id"));
  }
  if (!result.ok) return c.json({ ok: false, error: "continuous collection run not found" }, 404);
  return c.json(result);
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
      archiveTiers: c.req.query("archive_tiers") || c.req.query("archiveTiers") || c.req.query("tiers") || c.req.query("archive") || "",
      retentionClasses: c.req.query("retention_classes") || c.req.query("retentionClasses") || c.req.query("retention") || "",
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

// POST /api/plugins/sentiment/sentiment/search-index/maintain
app.post("/search-index/maintain", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(maintainSentimentSearchIndex({
    limit: parseLimit(body.limit, 1000),
    deleteOrphans: body.delete_orphans === false || body.deleteOrphans === false ? false : true,
    removeDuplicates: body.remove_duplicates === false || body.removeDuplicates === false ? false : true,
    autoRebuild: body.auto_rebuild === true || body.autoRebuild === true,
    maxMissingCount: Number(body.max_missing_count ?? body.maxMissingCount ?? 5000),
    minCoverageRatio: Number(body.min_coverage_ratio ?? body.minCoverageRatio ?? 80),
  }));
});

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

// GET /api/plugins/sentiment/sentiment/collection-jobs/backlog-maintenance
app.get("/collection-jobs/backlog-maintenance", (c) => c.json(maintainSentimentCollectionJobBacklog({
  apply: false,
  staleRunningLimit: parseLimit(c.req.query("stale_running_limit") || c.req.query("staleRunningLimit"), 20),
  retryLimit: parseLimit(c.req.query("retry_limit") || c.req.query("retryLimit"), 20),
  staleRunningMinutes: Number(c.req.query("stale_running_minutes") || c.req.query("staleRunningMinutes") || 30),
  operator: c.req.query("operator") || "api-preview",
  reason: c.req.query("reason") || "backlog maintenance preview",
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/backlog-maintenance
app.post("/collection-jobs/backlog-maintenance", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(maintainSentimentCollectionJobBacklog({
    apply: body.apply === true,
    staleRunningLimit: parseLimit(body.stale_running_limit || body.staleRunningLimit, 20),
    retryLimit: parseLimit(body.retry_limit || body.retryLimit, 20),
    staleRunningMinutes: Number(body.stale_running_minutes || body.staleRunningMinutes || 30),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

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

// GET /api/plugins/sentiment/sentiment/collection-jobs/deep-crawl-chain-gap-followups
app.get("/collection-jobs/deep-crawl-chain-gap-followups", (c) => c.json(planSentimentDeepCrawlChainGapFollowupJobs({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 30),
  rootUrl: c.req.query("root_url") || c.req.query("rootUrl") || "",
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/deep-crawl-chain-gap-followups
app.post("/collection-jobs/deep-crawl-chain-gap-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentDeepCrawlChainGapFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: body.limit || 30,
    rootUrl: body.root_url || body.rootUrl || "",
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || ""),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/deep-crawl-chain-gap-followup-effectiveness
app.get("/collection-jobs/deep-crawl-chain-gap-followup-effectiveness", (c) => c.json(getSentimentDeepCrawlChainGapFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

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
    includeDeepCrawlChainGaps: optionalBoolean(c.req.query("include_deep_crawl_chain_gaps") ?? c.req.query("includeDeepCrawlChainGaps"), true),
    includeSocialFollowup: optionalBoolean(c.req.query("include_social_followup") ?? c.req.query("includeSocialFollowup"), true),
    includeAccessBarrierAlternates: optionalBoolean(c.req.query("include_access_barrier_alternates") ?? c.req.query("includeAccessBarrierAlternates"), true),
    includeRssPrioritySiteGaps: optionalBoolean(c.req.query("include_rss_priority_site_gaps") ?? c.req.query("includeRssPrioritySiteGaps"), true),
    includeRssNativeEntryDiscovery: optionalBoolean(c.req.query("include_rss_native_entry_discovery") ?? c.req.query("includeRssNativeEntryDiscovery"), true),
    includeRssSourceFamilyRefresh: optionalBoolean(c.req.query("include_rss_source_family_refresh") ?? c.req.query("includeRssSourceFamilyRefresh"), true),
    includeEvidenceCoverageFollowups: optionalBoolean(c.req.query("include_evidence_coverage_followups") ?? c.req.query("includeEvidenceCoverageFollowups"), true),
    includePostScanEvidenceFollowups: optionalBoolean(c.req.query("include_post_scan_evidence_followups") ?? c.req.query("includePostScanEvidenceFollowups"), true),
    includeCollectionOperationsRemediation: optionalBoolean(c.req.query("include_collection_operations_remediation") ?? c.req.query("includeCollectionOperationsRemediation"), true),
    includeSourceFailurePersistentRecovery: optionalBoolean(c.req.query("include_source_failure_persistent_recovery") ?? c.req.query("includeSourceFailurePersistentRecovery"), true),
    includeRealtimeKeywordExpansionFamilyFanout: optionalBoolean(c.req.query("include_realtime_keyword_expansion_family_fanout") ?? c.req.query("includeRealtimeKeywordExpansionFamilyFanout"), true),
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
    includeDeepCrawlChainGaps: optionalBoolean(body.include_deep_crawl_chain_gaps ?? body.includeDeepCrawlChainGaps, true),
    includeSocialFollowup: optionalBoolean(body.include_social_followup ?? body.includeSocialFollowup, true),
    includeAccessBarrierAlternates: optionalBoolean(body.include_access_barrier_alternates ?? body.includeAccessBarrierAlternates, true),
    includeRssPrioritySiteGaps: optionalBoolean(body.include_rss_priority_site_gaps ?? body.includeRssPrioritySiteGaps, true),
    includeRssNativeEntryDiscovery: optionalBoolean(body.include_rss_native_entry_discovery ?? body.includeRssNativeEntryDiscovery, true),
    includeRssSourceFamilyRefresh: optionalBoolean(body.include_rss_source_family_refresh ?? body.includeRssSourceFamilyRefresh, true),
    includeEvidenceCoverageFollowups: optionalBoolean(body.include_evidence_coverage_followups ?? body.includeEvidenceCoverageFollowups, true),
    includePostScanEvidenceFollowups: optionalBoolean(body.include_post_scan_evidence_followups ?? body.includePostScanEvidenceFollowups, true),
    includeCollectionOperationsRemediation: optionalBoolean(body.include_collection_operations_remediation ?? body.includeCollectionOperationsRemediation, true),
    includeSourceFailurePersistentRecovery: optionalBoolean(body.include_source_failure_persistent_recovery ?? body.includeSourceFailurePersistentRecovery, true),
    includeRealtimeKeywordExpansionFamilyFanout: optionalBoolean(body.include_realtime_keyword_expansion_family_fanout ?? body.includeRealtimeKeywordExpansionFamilyFanout, true),
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

// GET /api/plugins/sentiment/sentiment/collection-jobs/source-failure-persistent-recovery
app.get("/collection-jobs/source-failure-persistent-recovery", (c) => {
  const { mode, sources, sourceScope } = resolveRouteQueryScanSources(c, c.req.query("mode") || "fast");
  const plan = planSentimentSourceFailurePersistentRecoveryJobs({
    days: c.req.query("days") || 7,
    limit: parseLimit(c.req.query("limit"), 30),
    minFailureCount: parseLimit(c.req.query("min_failure_count") || c.req.query("minFailureCount"), 1),
    minZeroResultCount: parseLimit(c.req.query("min_zero_result_count") || c.req.query("minZeroResultCount"), 2),
    includeZeroResults: optionalBoolean(c.req.query("include_zero_results") ?? c.req.query("includeZeroResults"), true),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 6),
    keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
    searchSettings: routeSearchSettingsWithSources(c, sources),
  });
  return c.json({
    ...plan,
    mode,
    sourceScope,
    requested_sources: sources || null,
  });
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/source-failure-persistent-recovery-effectiveness
app.get("/collection-jobs/source-failure-persistent-recovery-effectiveness", (c) => c.json(getSentimentSourceFailurePersistentRecoveryEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/source-failure-persistent-recovery
app.post("/collection-jobs/source-failure-persistent-recovery", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { mode, sources, sourceScope } = resolveRouteScanSources(c, body);
  const searchSettings = routeSearchSettingsWithSources(c, sources);
  const overrideSettings = body.search_settings || body.searchSettings || {};
  const result = applySentimentSourceFailurePersistentRecoveryJobs({
    apply: body.apply === true,
    days: body.days || 7,
    limit: parseLimit(body.limit, 30),
    minFailureCount: parseLimit(body.min_failure_count || body.minFailureCount, 1),
    minZeroResultCount: parseLimit(body.min_zero_result_count || body.minZeroResultCount, 2),
    includeZeroResults: optionalBoolean(body.include_zero_results ?? body.includeZeroResults, true),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 6),
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || body.keyword || body.q || ""),
    searchSettings: mergePlainSettings(searchSettings, overrideSettings),
    operator: body.operator || "",
    reason: body.reason || "",
  });
  return c.json({
    ...result,
    mode,
    sourceScope,
    requested_sources: sources || null,
  });
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/historical-window-backfill
app.get("/collection-jobs/historical-window-backfill", (c) => c.json(planSentimentHistoricalWindowBackfillJobs({
  keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
  lookbackDays: parseSyncLimit(c.req.query("lookback_days") || c.req.query("lookbackDays"), 365),
  windowDays: parseLimit(c.req.query("window_days") || c.req.query("windowDays"), 30),
  minRecentEvidence: parseNonNegativeLimit(c.req.query("min_recent_evidence") || c.req.query("minRecentEvidence"), 1),
  maxWindowEvidence: parseNonNegativeLimit(c.req.query("max_window_evidence") || c.req.query("maxWindowEvidence"), 0),
  maxWindowsPerKeyword: parseLimit(c.req.query("max_windows_per_keyword") || c.req.query("maxWindowsPerKeyword"), 4),
  maxSourcesPerWindow: parseLimit(c.req.query("max_sources_per_window") || c.req.query("maxSourcesPerWindow"), 2),
  sources: parseSourceList(c.req.query("sources") || c.req.query("source_keys") || c.req.query("sourceKeys") || ""),
  limit: parseLimit(c.req.query("limit"), 30),
  cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 24),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/historical-window-backfill
app.post("/collection-jobs/historical-window-backfill", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentHistoricalWindowBackfillJobs({
    apply: body.apply === true,
    keywords: normalizeSentimentMonitorKeywords(body.keywords || body.keyword || body.q || []),
    lookbackDays: parseSyncLimit(body.lookback_days ?? body.lookbackDays, 365),
    windowDays: parseLimit(body.window_days ?? body.windowDays, 30),
    minRecentEvidence: parseNonNegativeLimit(body.min_recent_evidence ?? body.minRecentEvidence, 1),
    maxWindowEvidence: parseNonNegativeLimit(body.max_window_evidence ?? body.maxWindowEvidence, 0),
    maxWindowsPerKeyword: parseLimit(body.max_windows_per_keyword ?? body.maxWindowsPerKeyword, 4),
    maxSourcesPerWindow: parseLimit(body.max_sources_per_window ?? body.maxSourcesPerWindow, 2),
    sources: parseSourceList(body.sources || body.source_keys || body.sourceKeys || ""),
    limit: parseLimit(body.limit, 30),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 24),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/historical-window-backfill-effectiveness
app.get("/collection-jobs/historical-window-backfill-effectiveness", (c) => c.json(getSentimentHistoricalWindowBackfillEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/author-pivot-followups
app.get("/collection-jobs/author-pivot-followups", (c) => c.json(planSentimentAuthorPivotFollowupJobs({
  days: c.req.query("days") || 30,
  keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
  minMentions: parseLimit(c.req.query("min_mentions") || c.req.query("minMentions"), 2),
  minHighRisk: parseNonNegativeLimit(c.req.query("min_high_risk") || c.req.query("minHighRisk"), 1),
  maxSourcesPerAuthor: parseLimit(c.req.query("max_sources_per_author") || c.req.query("maxSourcesPerAuthor"), 3),
  sources: parseSourceList(c.req.query("sources") || c.req.query("source_keys") || c.req.query("sourceKeys") || ""),
  limit: parseLimit(c.req.query("limit"), 30),
  cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/author-pivot-followups
app.post("/collection-jobs/author-pivot-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentAuthorPivotFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    keywords: normalizeSentimentMonitorKeywords(body.keywords || body.keyword || body.q || []),
    minMentions: parseLimit(body.min_mentions ?? body.minMentions, 2),
    minHighRisk: parseNonNegativeLimit(body.min_high_risk ?? body.minHighRisk, 1),
    maxSourcesPerAuthor: parseLimit(body.max_sources_per_author ?? body.maxSourcesPerAuthor, 3),
    sources: parseSourceList(body.sources || body.source_keys || body.sourceKeys || ""),
    limit: parseLimit(body.limit, 30),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/author-pivot-followup-effectiveness
app.get("/collection-jobs/author-pivot-followup-effectiveness", (c) => c.json(getSentimentAuthorPivotFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/author-reputation-followups
app.get("/collection-jobs/author-reputation-followups", (c) => c.json(planSentimentAuthorReputationFollowupJobs({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 30),
  minCoordinationRisk: parseNonNegativeLimit(c.req.query("min_coordination_risk") || c.req.query("minCoordinationRisk"), 55),
  minHighRisk: parseNonNegativeLimit(c.req.query("min_high_risk") || c.req.query("minHighRisk"), 1),
  maxReputationScore: parseNonNegativeLimit(c.req.query("max_reputation_score") || c.req.query("maxReputationScore"), 45),
  cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
  searchSettings: readSentimentSearchSettings(pluginCtx(c).config),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/author-reputation-followups
app.post("/collection-jobs/author-reputation-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentAuthorReputationFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minCoordinationRisk: parseNonNegativeLimit(body.min_coordination_risk ?? body.minCoordinationRisk, 55),
    minHighRisk: parseNonNegativeLimit(body.min_high_risk ?? body.minHighRisk, 1),
    maxReputationScore: parseNonNegativeLimit(body.max_reputation_score ?? body.maxReputationScore, 45),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    searchSettings: body.search_settings || body.searchSettings || readSentimentSearchSettings(pluginCtx(c).config),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/author-reputation-followup-effectiveness
app.get("/collection-jobs/author-reputation-followup-effectiveness", (c) => c.json(getSentimentAuthorReputationFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

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
  const options = collectionJobExecutionOptionsForRoute(body);
  if (optionalBoolean(body.async ?? body.asyncRun ?? body.background ?? body.backgroundRun, false)) {
    const ctx = pluginCtx(c);
    if (typeof ctx.startBackgroundCollectionJobExecution === "function") {
      const started = ctx.startBackgroundCollectionJobExecution({
        options,
        allowConcurrent: optionalBoolean(body.allow_concurrent ?? body.allowConcurrent, false),
      });
      return c.json({
        ...started,
        run_id: started.run?.id || null,
        poll_url: started.run?.id ? `/api/plugins/sentiment/sentiment/continuous-collection/runs/${started.run.id}` : null,
      }, 202);
    }
  }
  return c.json(await executeCollectionJobsForRoute(options, {
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

// GET /api/plugins/sentiment/sentiment/source-quality/drift
app.get("/source-quality/drift", (c) => c.json(listSentimentSourceQualityDrift({
  recentDays: c.req.query("recent_days") || c.req.query("recentDays") || 3,
  baselineDays: c.req.query("baseline_days") || c.req.query("baselineDays") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  minSamples: c.req.query("min_samples") || c.req.query("minSamples") || 3,
  minScans: c.req.query("min_scans") || c.req.query("minScans") || 1,
  now: c.req.query("now") ? Date.parse(c.req.query("now")) : Date.now(),
})));

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

// GET /api/plugins/sentiment/sentiment/collection-jobs/source-coverage-refresh-followups
app.get("/collection-jobs/source-coverage-refresh-followups", (c) => c.json(planSentimentSourceCoverageRefreshFollowupJobs({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 30),
  minCoverageScore: Number(c.req.query("min_coverage_score") || c.req.query("minCoverageScore") || 70),
  keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
  includeBlocked: optionalBoolean(c.req.query("include_blocked") ?? c.req.query("includeBlocked"), false),
  now: Number.isFinite(new Date(c.req.query("now") || "").getTime())
    ? new Date(c.req.query("now")).getTime()
    : Date.now(),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/source-coverage-refresh-effectiveness
app.get("/collection-jobs/source-coverage-refresh-effectiveness", (c) => c.json(getSentimentSourceCoverageRefreshFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/source-coverage-refresh-followups
app.post("/collection-jobs/source-coverage-refresh-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentSourceCoverageRefreshFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minCoverageScore: Number(body.min_coverage_score || body.minCoverageScore || 70),
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || body.keyword || body.q || ""),
    includeBlocked: optionalBoolean(body.include_blocked ?? body.includeBlocked, false),
    operator: body.operator || "",
    reason: body.reason || "",
    now: Number.isFinite(new Date(body.now || "").getTime()) ? new Date(body.now).getTime() : Date.now(),
  }));
});

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
  concurrency: c.req.query("concurrency") || c.req.query("validation_concurrency") || c.req.query("validationConcurrency") || 6,
  deadlineMs: c.req.query("deadline_ms") || c.req.query("deadlineMs") || c.req.query("validation_deadline_ms") || c.req.query("validationDeadlineMs") || 30000,
})));

// GET /api/plugins/sentiment/sentiment/source-discovery/deep-crawl-plan
app.get("/source-discovery/deep-crawl-plan", async (c) => c.json(await listSentimentSourceDiscoveryDeepCrawlPlan({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
  minScore: c.req.query("min_score") || c.req.query("minScore") || 45,
  candidateTypes: parseCsvQuery(c.req.query("types") || c.req.query("candidate_types") || "rss-feed,sitemap,author-profile,related-domain,site-search-or-topic,deep-crawl-outlink,event-cluster-followup,keyword-family-coverage-gap"),
  keywords: parseCsvQuery(c.req.query("keywords") || ""),
  timeoutMs: c.req.query("timeout_ms") || c.req.query("timeoutMs") || 8000,
  validationConcurrency: c.req.query("concurrency") || c.req.query("validation_concurrency") || c.req.query("validationConcurrency") || 6,
  validationDeadlineMs: c.req.query("deadline_ms") || c.req.query("deadlineMs") || c.req.query("validation_deadline_ms") || c.req.query("validationDeadlineMs") || 30000,
  targetLimit: parseLimit(c.req.query("target_limit") || c.req.query("targetLimit"), 80),
  includeCaptured: ["true", "1"].includes(String(c.req.query("include_captured") || c.req.query("includeCaptured") || "").toLowerCase()),
  includeSeen: ["true", "1"].includes(String(c.req.query("include_seen") || c.req.query("includeSeen") || "").toLowerCase()),
})));

// GET /api/plugins/sentiment/sentiment/source-discovery/deep-crawl-effectiveness
app.get("/source-discovery/deep-crawl-effectiveness", (c) => c.json(getSentimentSourceDiscoveryDeepCrawlEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 80),
})));

// POST /api/plugins/sentiment/sentiment/source-discovery/deep-crawl-plan/execute
app.post("/source-discovery/deep-crawl-plan/execute", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await executeSentimentSourceDiscoveryDeepCrawlPlan({
    days: body.days || 30,
    limit: body.limit || 100,
    minScore: body.min_score || body.minScore || 45,
    candidateTypes: body.types || body.candidate_types || body.candidateTypes || ["rss-feed", "sitemap", "author-profile", "related-domain", "site-search-or-topic", "deep-crawl-outlink", "event-cluster-followup", "keyword-family-coverage-gap"],
    keywords: body.keywords || [],
    timeoutMs: body.timeout_ms || body.timeoutMs || 8000,
    targetLimit: body.target_limit || body.targetLimit || 20,
    followupLimit: body.followup_limit || body.followupLimit || body.max_followup_targets || body.maxFollowupTargets || 0,
    sourceSearchFollowupLimit: body.source_search_followup_limit || body.sourceSearchFollowupLimit || body.max_source_search_followup_targets || body.maxSourceSearchFollowupTargets || null,
    sourceSearchPaginationLimit: body.source_search_pagination_limit || body.sourceSearchPaginationLimit || body.max_source_search_pagination_pages || body.maxSourceSearchPaginationPages || null,
    nestedFollowupLimit: body.nested_followup_limit || body.nestedFollowupLimit || body.max_nested_followup_targets || body.maxNestedFollowupTargets || null,
    fetchConcurrency: body.fetch_concurrency || body.fetchConcurrency || body.concurrency || 4,
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

// GET /api/plugins/sentiment/sentiment/collection-quality/commercial-query-fanout
app.get("/collection-quality/commercial-query-fanout", (c) => c.json(listSentimentCommercialQueryFanoutEffectiveness({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 50),
  minSamples: parseLimit(c.req.query("min_samples") || c.req.query("minSamples"), 1),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/commercial-query-fanout-followups
app.get("/collection-jobs/commercial-query-fanout-followups", (c) => c.json(planSentimentCommercialQueryFanoutFollowupJobs({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 30),
  minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 55),
  minEvidence: parseLimit(c.req.query("min_evidence") || c.req.query("minEvidence"), 1),
  includeWatch: optionalBoolean(c.req.query("include_watch") || c.req.query("includeWatch"), false),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/commercial-query-fanout-followups
app.post("/collection-jobs/commercial-query-fanout-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentCommercialQueryFanoutFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minScore: parseLimit(body.min_score || body.minScore, 55),
    minEvidence: parseLimit(body.min_evidence || body.minEvidence, 1),
    includeWatch: body.include_watch === true || body.includeWatch === true,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/realtime-keyword-expansion-followups
app.get("/collection-jobs/realtime-keyword-expansion-followups", (c) => c.json(planSentimentRealtimeKeywordExpansionFollowupJobs({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 30),
  minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 55),
  minResultCount: parseLimit(c.req.query("min_result_count") || c.req.query("minResultCount"), 1),
  cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 6),
  includeWatch: optionalBoolean(c.req.query("include_watch") || c.req.query("includeWatch"), false),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/realtime-keyword-expansion-followups
app.post("/collection-jobs/realtime-keyword-expansion-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRealtimeKeywordExpansionFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minScore: parseLimit(body.min_score || body.minScore, 55),
    minResultCount: parseLimit(body.min_result_count || body.minResultCount, 1),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 6),
    includeWatch: body.include_watch === true || body.includeWatch === true,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/keyword-realtime-expansion-route-followups
app.get("/collection-jobs/keyword-realtime-expansion-route-followups", async (c) => {
  const ctx = pluginCtx(c);
  const searchSettings = readSentimentSearchSettings(ctx.config);
  const aiSettings = readSentimentAiSettings(ctx.config);
  return c.json(await planSentimentKeywordRealtimeExpansionRouteFollowupJobs({
    keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
    mode: c.req.query("mode") || "fast",
    searchSettings,
    aiSettings,
    existingKeywords: parseCsvQuery(c.req.query("existing_keywords") || c.req.query("existingKeywords") || ""),
    limit: parseLimit(c.req.query("limit"), 30),
    candidateLimit: parseLimit(c.req.query("candidate_limit") || c.req.query("candidateLimit"), 100),
    maxSourcesPerPack: parseLimit(c.req.query("max_sources_per_pack") || c.req.query("maxSourcesPerPack"), 3),
    maxKeywordsPerJob: parseLimit(c.req.query("max_keywords_per_job") || c.req.query("maxKeywordsPerJob"), 8),
    includeDeepCrawl: optionalBoolean(c.req.query("include_deep_crawl") ?? c.req.query("includeDeepCrawl"), true),
    maxDeepCrawlPacks: parseLimit(c.req.query("max_deep_crawl_packs") || c.req.query("maxDeepCrawlPacks"), 3),
    maxDeepCrawlTargetsPerPack: parseLimit(c.req.query("max_deep_crawl_targets_per_pack") || c.req.query("maxDeepCrawlTargetsPerPack"), 3),
    minCandidateScore: parseNonNegativeLimit(c.req.query("min_candidate_score") || c.req.query("minCandidateScore"), 0, 100),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 6),
    forceRefresh: c.req.query("force") === "1" || c.req.query("force_refresh") === "1",
  }));
});

// POST /api/plugins/sentiment/sentiment/collection-jobs/keyword-realtime-expansion-route-followups
app.post("/collection-jobs/keyword-realtime-expansion-route-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ctx = pluginCtx(c);
  const baseSearchSettings = readSentimentSearchSettings(ctx.config);
  const searchSettingsOverride = body.search_settings || body.searchSettings || {};
  const searchSettings = readSentimentSearchSettings(mergePlainSettings(baseSearchSettings, searchSettingsOverride));
  const aiSettings = {
    ...readSentimentAiSettings(ctx.config),
    ...(body.ai_settings || body.aiSettings || {}),
  };
  return c.json(await applySentimentKeywordRealtimeExpansionRouteFollowupJobs({
    apply: body.apply === true,
    keywords: body.keywords || body.keyword || body.q || "",
    mode: body.mode || c.req.query("mode") || "fast",
    searchSettings,
    aiSettings,
    existingKeywords: body.existingKeywords || body.existing_keywords || [],
    limit: parseLimit(body.limit || c.req.query("limit"), 30),
    candidateLimit: parseLimit(body.candidateLimit || body.candidate_limit || c.req.query("candidate_limit") || c.req.query("candidateLimit"), 100),
    maxSourcesPerPack: parseLimit(body.maxSourcesPerPack || body.max_sources_per_pack || c.req.query("max_sources_per_pack") || c.req.query("maxSourcesPerPack"), 3),
    maxKeywordsPerJob: parseLimit(body.maxKeywordsPerJob || body.max_keywords_per_job || c.req.query("max_keywords_per_job") || c.req.query("maxKeywordsPerJob"), 8),
    includeDeepCrawl: optionalBoolean(body.include_deep_crawl ?? body.includeDeepCrawl ?? c.req.query("include_deep_crawl") ?? c.req.query("includeDeepCrawl"), true),
    maxDeepCrawlPacks: parseLimit(body.maxDeepCrawlPacks || body.max_deep_crawl_packs || c.req.query("max_deep_crawl_packs") || c.req.query("maxDeepCrawlPacks"), 3),
    maxDeepCrawlTargetsPerPack: parseLimit(body.maxDeepCrawlTargetsPerPack || body.max_deep_crawl_targets_per_pack || c.req.query("max_deep_crawl_targets_per_pack") || c.req.query("maxDeepCrawlTargetsPerPack"), 3),
    minCandidateScore: parseNonNegativeLimit(body.minCandidateScore || body.min_candidate_score || c.req.query("min_candidate_score") || c.req.query("minCandidateScore"), 0, 100),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours ?? c.req.query("cooldown_hours") ?? c.req.query("cooldownHours"), 6),
    forceRefresh: body.forceRefresh === true || body.force_refresh === true || c.req.query("force") === "1",
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/keyword-realtime-expansion-route-effectiveness
app.get("/collection-jobs/keyword-realtime-expansion-route-effectiveness", (c) => c.json(getSentimentKeywordRealtimeExpansionRouteFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/post-scan-realtime-keyword-expansion
app.get("/collection-jobs/post-scan-realtime-keyword-expansion", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(planSentimentPostScanRealtimeKeywordExpansionJobs({
    since: c.req.query("since") || c.req.query("started_at") || c.req.query("startedAt") || new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    keywords: parseCsvQuery(c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || ""),
    searchSettings,
    limit: parseLimit(c.req.query("limit"), 20),
    evidenceLimit: parseLimit(c.req.query("evidence_limit") || c.req.query("evidenceLimit"), 400),
    minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 45),
    maxSourcesPerCandidate: parseLimit(c.req.query("max_sources_per_candidate") || c.req.query("maxSourcesPerCandidate"), 3),
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/post-scan-realtime-keyword-expansion-effectiveness
app.get("/collection-jobs/post-scan-realtime-keyword-expansion-effectiveness", (c) => c.json(getSentimentPostScanRealtimeKeywordExpansionEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/post-scan-realtime-keyword-expansion
app.post("/collection-jobs/post-scan-realtime-keyword-expansion", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentPostScanRealtimeKeywordExpansionJobs({
    apply: body.apply === true,
    batchId: body.batch_id || body.batchId || null,
    since: body.since || body.started_at || body.startedAt || new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    keywords: Array.isArray(body.keywords) ? body.keywords : parseCsvQuery(body.keywords || body.keyword || body.q || ""),
    searchSettings,
    limit: parseLimit(body.limit, 20),
    evidenceLimit: parseLimit(body.evidence_limit || body.evidenceLimit, 400),
    minScore: parseLimit(body.min_score || body.minScore, 45),
    maxSourcesPerCandidate: parseLimit(body.max_sources_per_candidate || body.maxSourcesPerCandidate, 3),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/opensearch-archive-feedback-followups
app.get("/collection-jobs/opensearch-archive-feedback-followups", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minArchiveScore = c.req.query("min_archive_score") || c.req.query("minArchiveScore") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(planSentimentOpenSearchArchiveFeedbackFollowupJobs({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minArchiveScore: minArchiveScore === undefined || minArchiveScore === null || minArchiveScore === "" ? 60 : parseLimit(minArchiveScore, 60),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    searchSettings,
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/opensearch-archive-feedback-followup-effectiveness
app.get("/collection-jobs/opensearch-archive-feedback-followup-effectiveness", (c) => c.json(getSentimentOpenSearchArchiveFeedbackFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/opensearch-archive-feedback-followups
app.post("/collection-jobs/opensearch-archive-feedback-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentOpenSearchArchiveFeedbackFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minArchiveScore: parseLimit(body.min_archive_score || body.minArchiveScore || body.min_score || body.minScore, 60),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    searchSettings,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/high-value-evidence-followups
app.get("/collection-jobs/high-value-evidence-followups", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minArchiveScore = c.req.query("min_archive_score") || c.req.query("minArchiveScore") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(planSentimentHighValueEvidenceFollowupJobs({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minArchiveScore: minArchiveScore === undefined || minArchiveScore === null || minArchiveScore === "" ? 75 : parseLimit(minArchiveScore, 75),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    searchSettings,
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/high-value-evidence-followup-effectiveness
app.get("/collection-jobs/high-value-evidence-followup-effectiveness", (c) => c.json(getSentimentHighValueEvidenceFollowupEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/high-value-evidence-followups
app.post("/collection-jobs/high-value-evidence-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentHighValueEvidenceFollowupJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minArchiveScore: parseLimit(body.min_archive_score || body.minArchiveScore || body.min_score || body.minScore, 75),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    searchSettings,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/high-risk-evidence-revisits
app.get("/collection-jobs/high-risk-evidence-revisits", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(planSentimentHighRiskEvidenceRevisitJobs({
    days: c.req.query("days") || 90,
    limit: parseLimit(c.req.query("limit"), 30),
    minAgeHours: parseLimit(c.req.query("min_age_hours") || c.req.query("minAgeHours"), 6),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 24),
    maxSourcesPerEvidence: parseLimit(c.req.query("max_sources_per_evidence") || c.req.query("maxSourcesPerEvidence"), 3),
    searchSettings,
  }));
});

// POST /api/plugins/sentiment/sentiment/collection-jobs/high-risk-evidence-revisits
app.post("/collection-jobs/high-risk-evidence-revisits", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentHighRiskEvidenceRevisitJobs({
    apply: body.apply === true,
    days: body.days || 90,
    limit: parseLimit(body.limit, 30),
    minAgeHours: parseLimit(body.min_age_hours || body.minAgeHours, 6),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 24),
    maxSourcesPerEvidence: parseLimit(body.max_sources_per_evidence || body.maxSourcesPerEvidence, 3),
    searchSettings,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/high-risk-evidence-revisit-effectiveness
app.get("/collection-jobs/high-risk-evidence-revisit-effectiveness", (c) => c.json(getSentimentHighRiskEvidenceRevisitEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/high-value-evidence-corroboration
app.get("/collection-jobs/high-value-evidence-corroboration", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minArchiveScore = c.req.query("min_archive_score") || c.req.query("minArchiveScore") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(planSentimentHighValueEvidenceCorroborationJobs({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minArchiveScore: minArchiveScore === undefined || minArchiveScore === null || minArchiveScore === "" ? 75 : parseLimit(minArchiveScore, 75),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    maxTargetsPerEvidence: parseLimit(c.req.query("max_targets_per_evidence") || c.req.query("maxTargetsPerEvidence"), 4),
    searchSettings,
  }));
});

// GET /api/plugins/sentiment/sentiment/high-value-evidence/corroboration-gaps
app.get("/high-value-evidence/corroboration-gaps", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minArchiveScore = c.req.query("min_archive_score") || c.req.query("minArchiveScore") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(listSentimentHighValueEvidenceCorroborationGaps({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minArchiveScore: minArchiveScore === undefined || minArchiveScore === null || minArchiveScore === "" ? 75 : parseLimit(minArchiveScore, 75),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    maxTargetsPerEvidence: parseLimit(c.req.query("max_targets_per_evidence") || c.req.query("maxTargetsPerEvidence"), 4),
    searchSettings,
    now: c.req.query("now") ? Date.parse(c.req.query("now")) : Date.now(),
  }));
});

// POST /api/plugins/sentiment/sentiment/collection-jobs/high-value-evidence-corroboration
app.post("/collection-jobs/high-value-evidence-corroboration", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentHighValueEvidenceCorroborationJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minArchiveScore: parseLimit(body.min_archive_score || body.minArchiveScore || body.min_score || body.minScore, 75),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    maxTargetsPerEvidence: parseLimit(body.max_targets_per_evidence || body.maxTargetsPerEvidence, 4),
    searchSettings,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/high-value-evidence-corroboration-effectiveness
app.get("/collection-jobs/high-value-evidence-corroboration-effectiveness", (c) => c.json(getSentimentHighValueEvidenceCorroborationEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/fact-claim-corroboration
app.get("/collection-jobs/fact-claim-corroboration", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minConfidence = c.req.query("min_confidence") || c.req.query("minConfidence") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(planSentimentFactClaimCorroborationJobs({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minConfidence: minConfidence === undefined || minConfidence === null || minConfidence === "" ? 45 : parseLimit(minConfidence, 45),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    maxTargetsPerClaim: parseLimit(c.req.query("max_targets_per_claim") || c.req.query("maxTargetsPerClaim"), 4),
    searchSettings,
  }));
});

// GET /api/plugins/sentiment/sentiment/fact-claims/corroboration-gaps
app.get("/fact-claims/corroboration-gaps", (c) => {
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  const minConfidence = c.req.query("min_confidence") || c.req.query("minConfidence") || c.req.query("min_score") || c.req.query("minScore");
  return c.json(listSentimentFactClaimCorroborationGaps({
    days: c.req.query("days") || 30,
    limit: parseLimit(c.req.query("limit"), 30),
    minConfidence: minConfidence === undefined || minConfidence === null || minConfidence === "" ? 45 : parseLimit(minConfidence, 45),
    cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
    maxTargetsPerClaim: parseLimit(c.req.query("max_targets_per_claim") || c.req.query("maxTargetsPerClaim"), 4),
    searchSettings,
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/fact-claim-corroboration-effectiveness
app.get("/collection-jobs/fact-claim-corroboration-effectiveness", (c) => c.json(getSentimentFactClaimCorroborationEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/fact-claim-corroboration
app.post("/collection-jobs/fact-claim-corroboration", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const searchSettings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(applySentimentFactClaimCorroborationJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minConfidence: parseLimit(body.min_confidence || body.minConfidence || body.min_score || body.minScore, 45),
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    maxTargetsPerClaim: parseLimit(body.max_targets_per_claim || body.maxTargetsPerClaim, 4),
    searchSettings,
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/realtime-keyword-expansion-family-fanout
app.get("/collection-jobs/realtime-keyword-expansion-family-fanout", (c) => c.json(planSentimentRealtimeKeywordExpansionFamilyFanoutJobs({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 30),
  minScore: parseLimit(c.req.query("min_score") || c.req.query("minScore"), 55),
  minEvidence: parseLimit(c.req.query("min_evidence") || c.req.query("minEvidence"), 0),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/realtime-keyword-expansion-family-fanout
app.post("/collection-jobs/realtime-keyword-expansion-family-fanout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentRealtimeKeywordExpansionFamilyFanoutJobs({
    apply: body.apply === true,
    days: body.days || 30,
    limit: parseLimit(body.limit, 30),
    minScore: parseLimit(body.min_score || body.minScore, 55),
    minEvidence: parseLimit(body.min_evidence || body.minEvidence, 0),
    operator: body.operator || "",
    reason: body.reason || "",
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/realtime-keyword-expansion-family-fanout-effectiveness
app.get("/collection-jobs/realtime-keyword-expansion-family-fanout-effectiveness", (c) => c.json(getSentimentRealtimeKeywordExpansionFamilyFanoutEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

// GET /api/plugins/sentiment/sentiment/collection-jobs/realtime-keyword-expansion-candidate-fanout-effectiveness
app.get("/collection-jobs/realtime-keyword-expansion-candidate-fanout-effectiveness", (c) => c.json(getSentimentRealtimeKeywordExpansionCandidateFanoutEffectivenessReport({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 100),
})));

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

// GET /api/plugins/sentiment/sentiment/deep-crawl-evidence-chains
app.get("/deep-crawl-evidence-chains", (c) => c.json(listSentimentDeepCrawlEvidenceChains({
  days: c.req.query("days") || 30,
  limit: parseLimit(c.req.query("limit"), 50),
  rootUrl: c.req.query("root_url") || c.req.query("rootUrl") || "",
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

// POST /api/plugins/sentiment/sentiment/keyword-expansion/realtime
app.post("/keyword-expansion/realtime", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ctx = pluginCtx(c);
  const baseSearchSettings = readSentimentSearchSettings(ctx.config);
  const searchSettingsOverride = body.search_settings || body.searchSettings || {};
  const searchSettings = readSentimentSearchSettings(mergePlainSettings(baseSearchSettings, searchSettingsOverride));
  const aiSettings = {
    ...readSentimentAiSettings(ctx.config),
    ...(body.ai_settings || body.aiSettings || {}),
  };
  return c.json(await expandSentimentSearchKeywordsRealtime({
    keywords: body.keywords || body.keyword || body.q || "",
    mode: body.mode || c.req.query("mode") || "fast",
    searchSettings,
    aiSettings,
    existingKeywords: body.existingKeywords || body.existing_keywords || [],
    limit: parseLimit(body.limit || c.req.query("limit"), 80),
    forceRefresh: body.forceRefresh === true || body.force_refresh === true || c.req.query("force") === "1",
  }));
});

// POST /api/plugins/sentiment/sentiment/keyword-expansion/realtime-layer/plan
app.post("/keyword-expansion/realtime-layer/plan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ctx = pluginCtx(c);
  const baseSearchSettings = readSentimentSearchSettings(ctx.config);
  const searchSettingsOverride = body.search_settings || body.searchSettings || {};
  const searchSettings = readSentimentSearchSettings(mergePlainSettings(baseSearchSettings, searchSettingsOverride));
  const aiSettings = {
    ...readSentimentAiSettings(ctx.config),
    ...(body.ai_settings || body.aiSettings || {}),
  };
  return c.json(await planSentimentKeywordRealtimeExpansionLayer({
    keywords: body.keywords || body.keyword || body.q || "",
    mode: body.mode || c.req.query("mode") || "fast",
    searchSettings,
    aiSettings,
    existingKeywords: body.existingKeywords || body.existing_keywords || [],
    limit: parseLimit(body.limit || c.req.query("limit"), 80),
    candidateLimit: parseLimit(body.candidateLimit || body.candidate_limit || c.req.query("candidate_limit") || c.req.query("candidateLimit"), 80),
    forceRefresh: body.forceRefresh === true || body.force_refresh === true || c.req.query("force") === "1",
  }));
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

// GET /api/plugins/sentiment/sentiment/collection-jobs/event-cluster-followups
app.get("/collection-jobs/event-cluster-followups", (c) => c.json(planSentimentEventClusterFollowupJobs({
  limit: parseLimit(c.req.query("limit"), 20),
  minPropagationScore: c.req.query("min_propagation_score") || c.req.query("minPropagationScore") || 35,
  minPriorityBoost: c.req.query("min_priority_boost") || c.req.query("minPriorityBoost") || 16,
  cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 12),
  searchSettings: routeSearchSettingsWithSources(c, parseSourceList(c.req.query("sources") || c.req.query("source_keys") || c.req.query("sourceKeys"))),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/event-cluster-followups
app.post("/collection-jobs/event-cluster-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentEventClusterFollowupJobs({
    apply: body.apply !== false,
    limit: parseLimit(body.limit, 20),
    minPropagationScore: body.min_propagation_score ?? body.minPropagationScore ?? 35,
    minPriorityBoost: body.min_priority_boost ?? body.minPriorityBoost ?? 16,
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 12),
    searchSettings: routeSearchSettingsWithSources(c, parseSourceList(body.sources ?? body.source_keys ?? body.sourceKeys)),
    operator: body.operator || "route",
    reason: body.reason || "route-event-cluster-followup",
    now: Date.now(),
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/alert-event-followups
app.get("/collection-jobs/alert-event-followups", (c) => c.json(planSentimentAlertEventFollowupJobs({
  limit: parseLimit(c.req.query("limit"), 20),
  minPriorityBoost: c.req.query("min_priority_boost") || c.req.query("minPriorityBoost") || 24,
  cooldownHours: parseCooldownHours(c.req.query("cooldown_hours") || c.req.query("cooldownHours"), 6),
  searchSettings: routeSearchSettingsWithSources(c, parseSourceList(c.req.query("sources") || c.req.query("source_keys") || c.req.query("sourceKeys"))),
})));

// POST /api/plugins/sentiment/sentiment/collection-jobs/alert-event-followups
app.post("/collection-jobs/alert-event-followups", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(applySentimentAlertEventFollowupJobs({
    apply: body.apply !== false,
    limit: parseLimit(body.limit, 20),
    minPriorityBoost: body.min_priority_boost ?? body.minPriorityBoost ?? 24,
    cooldownHours: parseCooldownHours(body.cooldown_hours ?? body.cooldownHours, 6),
    searchSettings: routeSearchSettingsWithSources(c, parseSourceList(body.sources ?? body.source_keys ?? body.sourceKeys)),
    operator: body.operator || "route",
    reason: body.reason || "route-alert-event-followup",
    now: Date.now(),
  }));
});

// GET /api/plugins/sentiment/sentiment/collection-jobs/alert-event-followup-effectiveness
app.get("/collection-jobs/alert-event-followup-effectiveness", (c) => c.json(getSentimentAlertEventFollowupEffectivenessReport({
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
  const settings = mergeRequestOpenSearchSettings(readSentimentSearchSettings(pluginCtx(c).config), body);
  const sync = await syncSentimentOpenSearchArchive(settings, {
    limit: parseSyncLimit(body.limit || c.req.query("limit"), settings.openSearch?.maxSyncItems || 1000),
    dryRun: body.dryRun === true || body.dry_run === true || c.req.query("dry_run") === "1" || c.req.query("dryRun") === "true",
  });
  const replayOutbox = body.replay_outbox === true || body.replayOutbox === true || c.req.query("replay_outbox") === "1" || c.req.query("replayOutbox") === "true";
  const outbox = replayOutbox
    ? await syncSentimentOpenSearchArchiveOutbox(settings, {
      limit: parseSyncLimit(body.outbox_limit || body.outboxLimit || c.req.query("outbox_limit") || c.req.query("outboxLimit"), 100),
      dryRun: body.dryRun === true || body.dry_run === true || c.req.query("dry_run") === "1" || c.req.query("dryRun") === "true",
      includeFailed: body.include_failed !== false && body.includeFailed !== false && c.req.query("include_failed") !== "0" && c.req.query("includeFailed") !== "false",
      maxAttempts: parseSyncLimit(body.max_attempts || body.maxAttempts || c.req.query("max_attempts") || c.req.query("maxAttempts"), 5),
    })
    : { ok: true, status: "skipped", reason: "outbox-replay-not-requested" };
  return c.json({ ...sync, outbox_replay: outbox });
});

// POST /api/plugins/sentiment/sentiment/opensearch-maintenance
app.post("/opensearch-maintenance", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = readSentimentSearchSettings(pluginCtx(c).config);
  return c.json(await maintainSentimentOpenSearchArchive(settings, {
    dryRun: body.dryRun !== false && body.dry_run !== false && c.req.query("dry_run") !== "0" && c.req.query("dryRun") !== "false",
  }));
});

// GET /api/plugins/sentiment/sentiment/opensearch-archive-outbox
app.get("/opensearch-archive-outbox", (c) => {
  const status = c.req.query("status") || "";
  const limit = parseLimit(c.req.query("limit"), 50);
  return c.json({
    ...getSentimentOpenSearchArchiveOutboxStatus({ limit }),
    items: listSentimentOpenSearchArchiveOutbox({ status, limit }),
  });
});

// POST /api/plugins/sentiment/sentiment/opensearch-archive-outbox/sync
app.post("/opensearch-archive-outbox/sync", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const settings = mergeRequestOpenSearchSettings(readSentimentSearchSettings(pluginCtx(c).config), body);
  return c.json(await syncSentimentOpenSearchArchiveOutbox(settings, {
    limit: parseSyncLimit(body.limit || c.req.query("limit"), 100),
    dryRun: body.dryRun === true || body.dry_run === true || c.req.query("dry_run") === "1" || c.req.query("dryRun") === "true",
    includeFailed: body.include_failed !== false && body.includeFailed !== false && c.req.query("include_failed") !== "0" && c.req.query("includeFailed") !== "false",
    maxAttempts: parseSyncLimit(body.max_attempts || body.maxAttempts || c.req.query("max_attempts") || c.req.query("maxAttempts"), 5),
  }));
});

// POST /api/plugins/sentiment/sentiment/opensearch-archive-outbox/recover
app.post("/opensearch-archive-outbox/recover", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(recoverSentimentOpenSearchArchiveOutbox({
    status: body.statuses ?? body.status ?? c.req.query("statuses") ?? c.req.query("status") ?? "quarantined",
    documentIds: body.document_ids ?? body.documentIds ?? c.req.query("document_ids") ?? c.req.query("documentIds") ?? [],
    limit: parseSyncLimit(body.limit || c.req.query("limit"), 100),
    resetAttempts: body.reset_attempts === true || body.resetAttempts === true || c.req.query("reset_attempts") === "1" || c.req.query("resetAttempts") === "true",
  }));
});

// POST /api/plugins/sentiment/sentiment/opensearch-archive-outbox/purge
app.post("/opensearch-archive-outbox/purge", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(purgeSentimentOpenSearchArchiveOutbox({
    statuses: body.statuses ?? body.status ?? c.req.query("statuses") ?? c.req.query("status") ?? ["synced"],
    olderThanDays: body.older_than_days ?? body.olderThanDays ?? c.req.query("older_than_days") ?? c.req.query("olderThanDays") ?? 30,
    limit: parseSyncLimit(body.limit || c.req.query("limit"), 1000),
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
    const keywords = parseRouteKeywords(body, c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || "");
    if (rawSources !== undefined && !sources?.length) {
      return c.json({ ok: false, error: "sources must not be empty when provided", status: getSentimentMonitorStatus() }, 400);
    }
    const invalidSources = invalidSourceKeys(sources);
    if (invalidSources.length) {
      return c.json({ ok: false, error: `unknown sources: ${invalidSources.join(", ")}`, status: getSentimentMonitorStatus() }, 400);
    }
    const result = await runSentimentScanNow({ reason, mode, sources, keywords, days: body.days || body.scanDays || body.scan_days });
    return c.json({
      ok: true,
      result,
      status: getSentimentMonitorStatus(),
      dashboard: getSentimentDashboard({ limit: 50 }),
      mode,
      sourceScope,
      sources: sources || null,
      keywords,
      keywordRealtimeExpansionLayer: result.keywordRealtimeExpansionLayer || null,
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
    const keywords = parseRouteKeywords(body, c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || "");
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
      const job = { reason, mode, sources, keywords, days: body.days || body.scanDays || body.scan_days };
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
      keywords,
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
    const keywords = parseRouteKeywords(body, c.req.query("keywords") || c.req.query("keyword") || c.req.query("q") || "");
    if (rawSources !== undefined && !sources?.length) {
      return c.json({ ok: false, error: "sources must not be empty when provided", status: getSentimentMonitorStatus() }, 400);
    }
    const invalidSources = invalidSourceKeys(sources);
    if (invalidSources.length) {
      return c.json({ ok: false, error: `unknown sources: ${invalidSources.join(", ")}`, status: getSentimentMonitorStatus() }, 400);
    }
    const result = await runSentimentScanNow({ reason: "watch", mode, sources, keywords, days: body.days || body.scanDays || body.scan_days });
    return c.json({
      ok: true,
      result,
      status: getSentimentMonitorStatus(),
      dashboard: getSentimentDashboard({ limit: 50 }),
      mode,
      sourceScope,
      sources: sources || null,
      keywords,
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
