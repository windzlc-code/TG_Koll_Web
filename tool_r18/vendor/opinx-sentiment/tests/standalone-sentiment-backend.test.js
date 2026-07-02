import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentimentBackendApp } from "../standalone/sentiment-backend/src/server.js";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-sentiment-backend-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("standalone sentiment backend", () => {
  it("serves sentiment APIs without the Electron frontend", async () => {
    const dataDir = makeTempDir();
    const backend = createSentimentBackendApp({
      dataDir,
      enableScheduler: false,
      log: { info() {}, warn() {}, error() {} },
    });

    try {
      const home = await backend.app.request("/");
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toContain("text/html");
      expect(await home.text()).toContain("舆情全网搜索与研判");

      const appJs = await backend.app.request("/assets/app.js");
      expect(appJs.status).toBe(200);
      expect(appJs.headers.get("content-type")).toContain("text/javascript");

      const browserAuthBackground = await backend.app.request("/browser-auth-extension/background.js");
      expect(browserAuthBackground.status).toBe(200);
      const browserAuthBackgroundJs = await browserAuthBackground.text();
      for (const profileKey of [
        "ettoday",
        "nownews",
        "yahooNewsTaiwan",
        "udn",
        "chinatimes",
        "ltn",
        "mirrormedia",
        "storm",
        "thenewslens",
        "upmedia",
        "businessweekly",
        "cw",
        "businesstoday",
        "wealth",
        "moneydj",
        "cnyes",
      ]) {
        expect(browserAuthBackgroundJs).toContain(`key: "${profileKey}"`);
      }
      expect(browserAuthBackgroundJs).toContain('sourceKeys: ["taiwanNews", "rssFeeds"]');
      expect(browserAuthBackgroundJs).toContain('sourceKeys: ["taiwanNews", "yahooTaiwan", "rssFeeds"]');

      const admin = await backend.app.request("/admin");
      expect(admin.status).toBe(200);
      const adminHtml = await admin.text();
      expect(adminHtml).toContain("舆情系统后台管理");
      expect(adminHtml).toContain("RSS 媒体包覆盖");
      expect(adminHtml).toContain("台湾媒体健康");
      expect(adminHtml).toContain("taiwanMediaHealthSummary");
      expect(adminHtml).toContain("taiwanMediaHealthList");
      expect(adminHtml).toContain("台湾公共议题媒体健康");
      expect(adminHtml).toContain("taiwanPublicInterestHealthSummary");
      expect(adminHtml).toContain("taiwanPublicInterestHealthList");
      expect(adminHtml).toContain("taiwanNativeDiscoverySummary");
      expect(adminHtml).toContain("taiwanNativeDiscoveryList");
      expect(adminHtml).toContain("taiwanNativeDiscoveryRecoverySummary");
      expect(adminHtml).toContain("taiwanNativeDiscoveryRecoveryList");
      expect(adminHtml).toContain("enqueueTaiwanNativeDiscoveryBtn");
      expect(adminHtml).toContain("入队发现入口");
      expect(adminHtml).toContain("rssModeCoverageList");
      expect(adminHtml).toContain("rssPrioritySiteGapList");
      expect(adminHtml).toContain("连续采集运维");
      expect(adminHtml).toContain("continuousCollectionSummary");
      expect(adminHtml).toContain("continuousCollectionResultSummary");
      expect(adminHtml).toContain("continuousCollectionList");
      expect(adminHtml).toContain("reloadContinuousCollectionBtn");
      expect(adminHtml).toContain("runContinuousCollectionBtn");
      expect(adminHtml).toContain("免费来源目标覆盖");
      expect(adminHtml).toContain("freeTargetCoverageSummary");
      expect(adminHtml).toContain("freeTargetCoverageList");
      expect(adminHtml).toContain("freeTargetCoverageEffectivenessSummary");
      expect(adminHtml).toContain("freeTargetCoverageEffectivenessList");
      expect(adminHtml).toContain("reloadFreeTargetCoverageBtn");
      expect(adminHtml).toContain("enqueueFreeTargetCoverageBtn");
      expect(adminHtml).toContain("入队目标补扫");
      expect(adminHtml).toContain("rssFollowupJobList");
      expect(adminHtml).toContain("来源家族刷新任务");
      expect(adminHtml).toContain("rssSourceFamilyRefreshPlanList");
      expect(adminHtml).toContain("rssFollowupRecoveryList");
      expect(adminHtml).toContain("来源家族刷新恢复");
      expect(adminHtml).toContain("rssSourceFamilyRefreshRecoverySummary");
      expect(adminHtml).toContain("rssSourceFamilyRefreshRecoveryList");
      expect(adminHtml).toContain("入队补采任务");
      expect(adminHtml).toContain("applyRssModeRecommendationsBtn");
      expect(adminHtml).toContain("应用覆盖建议");
      expect(adminHtml).toContain("原生入口晋升效果");
      expect(adminHtml).toContain("reloadNativePromotionRefreshBtn");
      expect(adminHtml).toContain("applyNativePromotionGovernanceBtn");
      expect(adminHtml).toContain("enqueueNativePromotionRefreshBtn");
      expect(adminHtml).toContain("rssNativePromotionRefreshSummary");
      expect(adminHtml).toContain("rssNativePromotionSummary");
      expect(adminHtml).toContain("rssNativePromotionList");
      expect(adminHtml).toContain("rssNativePromotionRefreshRecoverySummary");
      expect(adminHtml).toContain("rssNativePromotionRefreshRecoveryList");
      expect(adminHtml).toContain("rssNativePromotionGovernanceSummary");
      expect(adminHtml).toContain("rssNativePromotionGovernanceList");

      const adminJs = await backend.app.request("/assets/admin.js");
      expect(adminJs.status).toBe(200);
      const adminJsText = await adminJs.text();
      expect(adminJsText).toContain("renderRssModeCoverage");
      expect(adminJsText).toContain("renderTaiwanMediaHealth");
      expect(adminJsText).toContain("renderTaiwanPublicInterestHealth");
      expect(adminJsText).toContain("renderTaiwanNativeDiscoveryPlan");
      expect(adminJsText).toContain("renderTaiwanNativeDiscoveryRecovery");
      expect(adminJsText).toContain("taiwanNativeDiscoveryPlanUrl");
      expect(adminJsText).toContain("rss-native-entry-discovery-recovery");
      expect(adminJsText).toContain("pack_groups");
      expect(adminJsText).toContain("包级恢复");
      expect(adminJsText).toContain("not_started_missing_native_entry_site_count");
      expect(adminJsText).toContain("rss_native_entry_discovery_unattempted_jobs");
      expect(adminJsText).toContain("rss_native_entry_discovery_recent_attempt_jobs");
      expect(adminJsText).toContain("rss_native_entry_discovery_pack_groups");
      expect(adminJsText).toContain("rss_native_entry_discovery_pack_group_count");
      expect(adminJsText).toContain("renderTaiwanNativeDiscoveryPlan(payload)");
      expect(adminJsText).toContain("created_rss_native_entry_discovery_jobs");
      expect(adminJsText).toContain("created_rss_native_entry_discovery_pack_group_count");
      expect(adminJsText).toContain("created_rss_native_entry_discovery_pack_groups");
      expect(adminJsText).toContain("created_job_count");
      expect(adminJsText).toContain("updated_job_count");
      expect(adminJsText).toContain("recovered_stale_running_job_count");
      expect(adminJsText).toContain("skipped_running_job_count");
      expect(adminJsText).toContain("max_running_age_minutes");
      expect(adminJsText).toContain("最久");
      expect(adminJsText).toContain("newly_created_rss_native_entry_discovery_jobs");
      expect(adminJsText).toContain("updated_existing_rss_native_entry_discovery_jobs");
      expect(adminJsText).toContain("recovered_stale_running_rss_native_entry_discovery_jobs");
      expect(adminJsText).toContain("skipped_running_rss_native_entry_discovery_jobs");
      expect(adminJsText).toContain("skipped_running_rss_native_entry_discovery_pack_group_count");
      expect(adminJsText).toContain("已入队/更新");
      expect(adminJsText).toContain("恢复卡死");
      expect(adminJsText).toContain("运行中跳过");
      expect(adminJsText).toContain("入口发现任务 · 新建");
      expect(adminJsText).toContain("enqueueTaiwanNativeDiscovery");
      expect(adminJsText).toContain("includeRssNativeEntryDiscovery");
      expect(adminJsText).toContain("include_rss_native_entry_discovery=1");
      expect(adminJsText).toContain("taiwan-media-health");
      expect(adminJsText).toContain("taiwan-public-interest-health");
      expect(adminJsText).toContain("\"taiwanPublicInterest\"");
      expect(adminJsText).toContain("indexed_only_site_count");
      expect(adminJsText).toContain("coverage_status");
      expect(adminJsText).toContain("renderRssPrioritySiteGaps");
      expect(adminJsText).toContain("mode_coverage");
      expect(adminJsText).toContain("priority_site_gaps");
      expect(adminJsText).toContain("priority_sites");
      expect(adminJsText).toContain("continuousCollectionPlanUrl");
      expect(adminJsText).toContain("renderContinuousCollectionPlan");
      expect(adminJsText).toContain("renderContinuousCollectionResult");
      expect(adminJsText).toContain("runContinuousCollection");
      expect(adminJsText).toContain("continuous-collection-plan");
      expect(adminJsText).toContain("continuous-collection/run");
      expect(adminJsText).toContain("postScanFollowupLimit");
      expect(adminJsText).toContain("postScanFollowupResult");
      expect(adminJsText).toContain("discoveryDeepCrawlLimit");
      expect(adminJsText).toContain("freeTargetCoverageUrl");
      expect(adminJsText).toContain("freeTargetCoverageEffectivenessUrl");
      expect(adminJsText).toContain("freeTargetCoverageFollowupUrl");
      expect(adminJsText).toContain("renderFreeTargetCoverage");
      expect(adminJsText).toContain("renderFreeTargetCoverageEffectiveness");
      expect(adminJsText).toContain("loadFreeTargetCoverage");
      expect(adminJsText).toContain("enqueueFreeTargetCoverageFollowups");
      expect(adminJsText).toContain("free-source-target-coverage");
      expect(adminJsText).toContain("free-source-target-coverage-effectiveness");
      expect(adminJsText).toContain("free-source-target-coverage-followups");
      expect(adminJsText).toContain("missing_profile_count");
      expect(adminJsText).toContain("recovered_source_count");
      expect(adminJsText).toContain("created_jobs");
      expect(adminJsText).toContain("skipped_running_jobs");
      expect(adminJsText).toContain("renderRssPackSiteBadges");
      expect(adminJsText).toContain("站点清单");
      expect(adminJsText).toContain("rss-pack-config-sites");
      expect(adminJsText).toContain("rss-pack-sites");
      expect(adminJsText).toContain("renderRssFollowupPlan");
      expect(adminJsText).toContain("renderRssFollowupRecovery");
      expect(adminJsText).toContain("renderRssSourceFamilyRefreshRecovery");
      expect(adminJsText).toContain("rssSourceFamilyRefreshPlanList");
      expect(adminJsText).toContain("include_rss_priority_site_gaps=1");
      expect(adminJsText).toContain("include_rss_source_family_refresh=1");
      expect(adminJsText).toContain("include_collection_operations_remediation=0");
      expect(adminJsText).toContain("include_free_source_target_coverage_followups=0");
      expect(adminJsText).toContain("includeRssPrioritySiteGaps");
      expect(adminJsText).toContain("includeRssSourceFamilyRefresh");
      expect(adminJsText).toContain("includeCollectionOperationsRemediation");
      expect(adminJsText).toContain("includeFreeSourceTargetCoverageFollowups");
      expect(adminJsText).toContain("recovery_index_engines");
      expect(adminJsText).toContain("requested_index_feed_count");
      expect(adminJsText).toContain("failed_index_engines");
      expect(adminJsText).toContain("inserted_count");
      expect(adminJsText).toContain("Google News");
      expect(adminJsText).toContain("Bing News");
      expect(adminJsText).toContain("rss_priority_site_empty_recovery_jobs");
      expect(adminJsText).toContain("rss_priority_site_dual_index_jobs");
      expect(adminJsText).toContain("rss_source_family_refresh_jobs");
      expect(adminJsText).toContain("rss_source_family_refresh_families");
      expect(adminJsText).toContain("created_rss_source_family_refresh_jobs");
      expect(adminJsText).toContain("skipped_running_rss_source_family_refresh_jobs");
      expect(adminJsText).toContain("metadata?.task_type === \"rss-source-family-refresh\"");
      expect(adminJsText).toContain("configured_score");
      expect(adminJsText).toContain("observed_score");
      expect(adminJsText).toContain("requested_pack_count");
      expect(adminJsText).toContain("diagnostic_failure_count");
      expect(adminJsText).toContain("failed_targets");
      expect(adminJsText).toContain("recommended_action");
      expect(adminJsText).toContain("recommendation_text");
      expect(adminJsText).toContain("stale_site_count");
      expect(adminJsText).toContain("dual_index_site_count");
      expect(adminJsText).toContain("runtime_recovery_site_count");
      expect(adminJsText).toContain("runtime_unhealthy_feed_count");
      expect(adminJsText).toContain("rss-priority-site-gap-recovery");
      expect(adminJsText).toContain("rss-source-family-refresh-recovery");
      expect(adminJsText).toContain("重点站点");
      expect(adminJsText).toContain("来源家族刷新");
      expect(adminJsText).toContain("priority_site_family_groups");
      expect(adminJsText).toContain("分组");
      expect(adminJsText).toContain("empty_priority_sites");
      expect(adminJsText).toContain("recommendations");
      expect(adminJsText).toContain("建议");
      expect(adminJsText).toContain("applyRssModeRecommendations");
      expect(adminJsText).toContain("rss-feed-pack-coverage/apply-recommendations");
      expect(adminJsText).toContain("applied_count");
      expect(adminJsText).toContain("coverage_delta");
      expect(adminJsText).toContain("added_pack_count");
      expect(adminJsText).toContain("priority_site_delta");
      expect(adminJsText).toContain("index_redundancy");
      expect(adminJsText).toContain("双索引站点");
      expect(adminJsText).toContain("无索引缺口");
      expect(adminJsText).toContain("新鲜站点");
      expect(adminJsText).toContain("久未更新");
      expect(adminJsText).toContain("stale_priority_sites");
      expect(adminJsText).toContain("recommendation_type === \"collection\"");
      expect(adminJsText).toContain("已应用");
      expect(adminJsText).toContain("可一键应用");
      expect(adminJsText).toContain("需入队补采");
      expect(adminJsText).toContain("renderNativePromotionEffectiveness");
      expect(adminJsText).toContain("renderNativePromotionRefreshPlan");
      expect(adminJsText).toContain("renderNativePromotionRefreshRecovery");
      expect(adminJsText).toContain("renderNativePromotionGovernance");
      expect(adminJsText).toContain("native-entry-promotion-effectiveness");
      expect(adminJsText).toContain("native-entry-promotion-governance");
      expect(adminJsText).toContain("native-entry-promotion-governance/apply");
      expect(adminJsText).toContain("rss-native-entry-promotion-refresh");
      expect(adminJsText).toContain("rss-native-entry-promotion-refresh-recovery");
      expect(adminJsText).toContain("productive_feed_count");
      expect(adminJsText).toContain("stale_feed_count");
      expect(adminJsText).toContain("empty_feed_count");
      expect(adminJsText).toContain("refresh_job_count");
      expect(adminJsText).toContain("recovered_feed_count");
      expect(adminJsText).toContain("inserted_pending_feed_count");
      expect(adminJsText).toContain("manual_review_count");

      const adminSettingsResponse = await backend.app.request("/api/admin-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scanDays: 45,
          reportDays: 60,
          sourceScopes: {
            fast: ["googleNews", "ptt", "googleNews"],
            full: ["googleNews", "publicProductRecallSources"],
            watch: ["threads"],
          },
        }),
      });
      expect(adminSettingsResponse.status).toBe(200);
      expect(await adminSettingsResponse.json()).toMatchObject({
        ok: true,
        settings: {
          scanDays: 45,
          reportDays: 60,
          sourceScopes: {
            fast: ["googleNews", "ptt"],
            full: ["googleNews", "publicProductRecallSources"],
            watch: ["threads"],
          },
        },
      });

      const dateOnlyAdminSettingsResponse = await backend.app.request("/api/admin-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scanDays: 14, reportDays: 21 }),
      });
      expect(dateOnlyAdminSettingsResponse.status).toBe(200);
      expect(await dateOnlyAdminSettingsResponse.json()).toMatchObject({
        settings: {
          scanDays: 14,
          reportDays: 21,
          sourceScopes: {
            fast: ["googleNews", "ptt"],
            full: ["googleNews", "publicProductRecallSources"],
            watch: ["threads"],
          },
        },
      });

      const monitorResponse = await backend.app.request("/api/sentiment/monitor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intervalMinutes: 5,
          mode: "deep",
          watchEnabled: true,
          watchIntervalMinutes: 2,
        }),
      });
      expect(monitorResponse.status).toBe(200);
      expect(await monitorResponse.json()).toMatchObject({
        enabled: true,
        mode: "full",
        sources: ["googleNews", "publicProductRecallSources"],
        watchEnabled: true,
        watchSources: ["threads"],
      });

      const continuousPlanResponse = await backend.app.request("/api/sentiment/continuous-collection-plan?mode=deep&max_sources=5");
      expect(continuousPlanResponse.status).toBe(200);
      expect(await continuousPlanResponse.json()).toMatchObject({
        mode: "full",
        sourceScope: "admin-settings",
        requested_sources: ["googleNews", "publicProductRecallSources"],
      });

      const continuousWorkerResponse = await backend.app.request("/api/sentiment/continuous-collection/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          async: true,
          mode: "fast",
          scanSources: false,
          retryJobs: false,
          deferContinuousCollectionExecution: true,
          deferContinuousCollectionReason: "standalone-worker-test-deferred",
        }),
      });
      expect(continuousWorkerResponse.status).toBe(202);
      const continuousWorkerBody = await continuousWorkerResponse.json();
      expect(continuousWorkerBody).toMatchObject({
        ok: true,
        accepted: true,
        already_running: false,
        run_id: expect.any(String),
        run: {
          worker: {
            external_process: true,
            pid: expect.any(Number),
          },
        },
      });
      let continuousWorkerStatus = null;
      for (let index = 0; index < 40; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const statusResponse = await backend.app.request(`/api/sentiment/continuous-collection/runs/${continuousWorkerBody.run_id}`);
        continuousWorkerStatus = await statusResponse.json();
        if (continuousWorkerStatus.run?.status === "success" || continuousWorkerStatus.run?.status === "failed") break;
      }
      expect(continuousWorkerStatus).toMatchObject({
        ok: true,
        run: {
          id: continuousWorkerBody.run_id,
          status: "success",
          heartbeat_at: expect.any(String),
          heartbeat_elapsed_ms: expect.any(Number),
          result: {
            ok: true,
            deferred: true,
            reason: "standalone-worker-test-deferred",
          },
        },
      });

      const staleRunId = "continuous-stale-worker-test";
      const staleRunDir = path.join(dataDir, "continuous-runs");
      fs.mkdirSync(staleRunDir, { recursive: true });
      fs.writeFileSync(path.join(staleRunDir, `${staleRunId}.json`), `${JSON.stringify({
        id: staleRunId,
        status: "running",
        accepted: true,
        mode: "fast",
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        worker: {
          external_process: true,
          pid: 99999999,
        },
        result: null,
        error: "",
      }, null, 2)}\n`, "utf8");
      const staleRunResponse = await backend.app.request(`/api/sentiment/continuous-collection/runs/${staleRunId}`);
      expect(await staleRunResponse.json()).toMatchObject({
        ok: true,
        run: {
          id: staleRunId,
          status: "failed",
          error: expect.stringContaining("worker process not running"),
          worker: {
            external_process: true,
            alive: false,
          },
        },
      });

      const largeRunId = "continuous-large-result-test";
      fs.writeFileSync(path.join(staleRunDir, `${largeRunId}.json`), `${JSON.stringify({
        id: largeRunId,
        status: "success",
        accepted: true,
        mode: "fast",
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 12,
        result: {
          ok: true,
          plan: {
            mode: "fast",
            ready_scan_sources: Array.from({ length: 500 }, (_, index) => `source-${index}`),
          },
          executed_scan_sources: ["googleNews"],
          retryResult: {
            ok: true,
            executed: 1,
            total: 2,
            jobs: Array.from({ length: 500 }, (_, index) => ({ id: index, payload: "x".repeat(1000) })),
          },
        },
        error: "",
      }, null, 2)}\n`, "utf8");
      const largeRunResponse = await backend.app.request(`/api/sentiment/continuous-collection/runs/${largeRunId}`);
      const largeRunBody = await largeRunResponse.json();
      expect(largeRunBody).toMatchObject({
        ok: true,
        run: {
          id: largeRunId,
          result_full_available: true,
          result: {
            ok: true,
            deferred: false,
            executed_scan_source_count: 1,
            retryResult: {
              executed: 1,
              total: 2,
              job_count: 500,
            },
          },
        },
      });
      expect(JSON.stringify(largeRunBody).length).toBeLessThan(6000);

      const executeDueWorkerResponse = await backend.app.request("/api/sentiment/collection-jobs/execute-due", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          async: true,
          limit: 2,
          concurrency: 2,
          drainBatches: 2,
          taskType: "source-coverage-refresh-followup",
          collectionJobTimeoutMs: 5000,
        }),
      });
      expect(executeDueWorkerResponse.status).toBe(202);
      const executeDueWorkerBody = await executeDueWorkerResponse.json();
      expect(executeDueWorkerBody).toMatchObject({
        ok: true,
        accepted: true,
        run_id: expect.stringMatching(/^collection-jobs-/),
        run: {
          options: {
            limit: 2,
            concurrency: 2,
            drainBatches: 2,
            sourceCoverageRefreshFollowupsOnly: true,
            collectionJobTimeoutMs: 5000,
          },
          worker: {
            external_process: true,
            type: "collection-jobs-execute-due",
            pid: expect.any(Number),
          },
        },
      });
      let executeDueWorkerStatus = null;
      for (let index = 0; index < 40; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const statusResponse = await backend.app.request(`/api/sentiment/continuous-collection/runs/${executeDueWorkerBody.run_id}`);
        executeDueWorkerStatus = await statusResponse.json();
        if (executeDueWorkerStatus.run?.status === "success" || executeDueWorkerStatus.run?.status === "failed") break;
      }
      expect(executeDueWorkerStatus).toMatchObject({
        ok: true,
        run: {
          id: executeDueWorkerBody.run_id,
          status: "success",
          options: {
            limit: 2,
            concurrency: 2,
            drainBatches: 2,
            sourceCoverageRefreshFollowupsOnly: true,
            collectionJobTimeoutMs: 5000,
          },
          result: {
            ok: true,
            deferred: false,
            type: "collection-jobs-execute-due",
            collectionJobResult: {
              executed: 0,
              total: 0,
              job_count: 0,
              backlogDrain: {
                requested_batches: 2,
                executed_batches: 1,
                execution_limit: 2,
                execution_concurrency: 2,
                stopped_reason: "no-due-collection-jobs",
              },
            },
          },
        },
      });

      const collectionOperationsResponse = await backend.app.request("/api/sentiment/collection-operations?mode=deep&max_sources=5");
      expect(collectionOperationsResponse.status).toBe(200);
      expect(await collectionOperationsResponse.json()).toMatchObject({
        mode: "full",
        sourceScope: "admin-settings",
        requested_sources: ["googleNews", "publicProductRecallSources"],
      });

      const collectionOperationsRemediationResponse = await backend.app.request("/api/sentiment/collection-operations/remediation?mode=deep&limit=5");
      expect(collectionOperationsRemediationResponse.status).toBe(200);
      expect(await collectionOperationsRemediationResponse.json()).toMatchObject({
        mode: "full",
        sourceScope: "admin-settings",
        requested_sources: ["googleNews", "publicProductRecallSources"],
        applied: false,
      });

      const collectionOperationsRemediationApplyResponse = await backend.app.request("/api/sentiment/collection-operations/remediation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: false, mode: "deep", limit: 5 }),
      });
      expect(collectionOperationsRemediationApplyResponse.status).toBe(200);
      expect(await collectionOperationsRemediationApplyResponse.json()).toMatchObject({
        mode: "full",
        sourceScope: "admin-settings",
        requested_sources: ["googleNews", "publicProductRecallSources"],
        applied: false,
      });

      const collectionOperationsExplicitSourcesResponse = await backend.app.request("/api/sentiment/collection-operations?mode=deep&sources=threads");
      expect(collectionOperationsExplicitSourcesResponse.status).toBe(200);
      expect(await collectionOperationsExplicitSourcesResponse.json()).toMatchObject({
        mode: "full",
        sourceScope: "request",
        requested_sources: ["threads"],
      });

      const apiInfo = await backend.app.request("/api");
      expect(apiInfo.status).toBe(200);
      expect(await apiInfo.json()).toMatchObject({ ok: true, name: "opinx-sentiment-backend" });

      const rssPackCoverage = await backend.app.request("/api/sentiment/rss-feed-pack-coverage?days=30");
      expect(rssPackCoverage.status).toBe(200);
      const rssPackCoverageJson = await rssPackCoverage.json();
      expect(rssPackCoverageJson).toMatchObject({
        ok: true,
        summary: {
          configured_pack_count: expect.any(Number),
          observed_pack_count: expect.any(Number),
          stale_or_empty_pack_count: expect.any(Number),
          mode_empty_pack_count: expect.any(Number),
          priority_site_count: expect.any(Number),
          observed_priority_site_count: expect.any(Number),
          fresh_priority_site_count: expect.any(Number),
          stale_priority_site_count: expect.any(Number),
          empty_priority_site_count: expect.any(Number),
          index_redundancy: expect.objectContaining({
            google_news_index_feed_count: expect.any(Number),
            bing_news_index_feed_count: expect.any(Number),
            dual_index_site_count: expect.any(Number),
          }),
          entry_coverage: expect.objectContaining({
            site_count: expect.any(Number),
            dual_index_ready_site_count: expect.any(Number),
            native_entry_site_count: expect.any(Number),
            low_redundancy_site_count: expect.any(Number),
          }),
        },
        priority_site_family_groups: expect.arrayContaining([
          expect.objectContaining({
            family: "taiwan_media",
            pack_key: "taiwanMedia",
            priority_site_count: expect.any(Number),
          }),
          expect.objectContaining({
            family: "taiwan_business_media",
            pack_key: "taiwanMedia",
            priority_site_count: expect.any(Number),
          }),
        ]),
        mode_coverage: expect.arrayContaining([
          expect.objectContaining({
            mode: "fast",
            selected_pack_count: expect.any(Number),
            empty_selected_pack_count: expect.any(Number),
            priority_site_count: expect.any(Number),
            observed_priority_site_count: expect.any(Number),
            fresh_priority_site_count: expect.any(Number),
            stale_priority_site_count: expect.any(Number),
            empty_priority_site_count: expect.any(Number),
            priority_site_family_groups: expect.any(Array),
            empty_priority_sites: expect.any(Array),
            stale_priority_sites: expect.any(Array),
            index_redundancy: expect.any(Object),
            entry_coverage: expect.any(Object),
            recommendations: expect.any(Array),
          }),
          expect.objectContaining({
            mode: "full",
            selected_pack_count: expect.any(Number),
            empty_selected_pack_count: expect.any(Number),
            priority_site_count: expect.any(Number),
            observed_priority_site_count: expect.any(Number),
            fresh_priority_site_count: expect.any(Number),
            stale_priority_site_count: expect.any(Number),
            empty_priority_site_count: expect.any(Number),
            priority_site_family_groups: expect.any(Array),
            empty_priority_sites: expect.any(Array),
            stale_priority_sites: expect.any(Array),
            index_redundancy: expect.any(Object),
            entry_coverage: expect.any(Object),
            recommendations: expect.any(Array),
          }),
          expect.objectContaining({
            mode: "watch",
            selected_pack_count: expect.any(Number),
            empty_selected_pack_count: expect.any(Number),
          }),
        ]),
        packs: expect.arrayContaining([
          expect.objectContaining({
            pack_key: "taiwanMedia",
            pack_label: "台灣重點新聞/財經媒體",
            index_redundancy: expect.objectContaining({
              google_news_index_feed_count: expect.any(Number),
              bing_news_index_feed_count: expect.any(Number),
              dual_index_site_count: expect.any(Number),
            }),
            entry_coverage: expect.objectContaining({
              site_count: 16,
              dual_index_ready_site_count: 16,
              missing_google_index_site_count: 0,
              missing_bing_index_site_count: 0,
              sites: expect.arrayContaining([
                expect.objectContaining({
                  name: "NOWnews今日新聞",
                  site: "nownews.com",
                  dual_index_ready: true,
                  has_native_entry: true,
                }),
                expect.objectContaining({
                  name: "上報",
                  site: "upmedia.mg",
                  dual_index_ready: true,
                  has_native_entry: true,
                }),
              ]),
            }),
            priority_site_family_groups: expect.arrayContaining([
              expect.objectContaining({ family: "taiwan_media", priority_site_count: 10 }),
              expect.objectContaining({ family: "taiwan_business_media", priority_site_count: 6 }),
            ]),
            configured_required_site_count: 16,
            priority_sites: expect.arrayContaining([
              expect.objectContaining({ name: "ETtoday新聞雲", site: "ettoday.net/news" }),
              expect.objectContaining({ name: "NOWnews今日新聞", site: "nownews.com" }),
              expect.objectContaining({ name: "Yahoo奇摩新聞", site: "tw.news.yahoo.com" }),
              expect.objectContaining({ name: "聯合新聞網", site: "udn.com/news" }),
              expect.objectContaining({ name: "中時新聞網", site: "chinatimes.com" }),
              expect.objectContaining({ name: "自由時報電子報", site: "news.ltn.com.tw" }),
              expect.objectContaining({ name: "鏡週刊", site: "mirrormedia.mg" }),
              expect.objectContaining({ name: "風傳媒", site: "storm.mg" }),
              expect.objectContaining({ name: "關鍵評論網", site: "thenewslens.com" }),
              expect.objectContaining({ name: "上報", site: "upmedia.mg" }),
              expect.objectContaining({ name: "商業周刊", site: "businessweekly.com.tw" }),
              expect.objectContaining({ name: "天下雜誌", site: "cw.com.tw" }),
              expect.objectContaining({ name: "今周刊", site: "businesstoday.com.tw" }),
              expect.objectContaining({ name: "財訊", site: "wealth.com.tw" }),
              expect.objectContaining({ name: "MoneyDJ理財網", site: "moneydj.com" }),
              expect.objectContaining({ name: "鉅亨網", site: "news.cnyes.com" }),
            ]),
            required_sites: expect.arrayContaining([
              expect.objectContaining({ name: "ETtoday新聞雲", site: "ettoday.net/news", required: true }),
              expect.objectContaining({ name: "NOWnews今日新聞", site: "nownews.com", required: true }),
              expect.objectContaining({ name: "Yahoo奇摩新聞", site: "tw.news.yahoo.com", required: true }),
              expect.objectContaining({ name: "聯合新聞網", site: "udn.com/news", required: true }),
              expect.objectContaining({ name: "中時新聞網", site: "chinatimes.com", required: true }),
              expect.objectContaining({ name: "自由時報電子報", site: "news.ltn.com.tw", required: true }),
              expect.objectContaining({ name: "鏡週刊", site: "mirrormedia.mg", required: true }),
              expect.objectContaining({ name: "風傳媒", site: "storm.mg", required: true }),
              expect.objectContaining({ name: "關鍵評論網", site: "thenewslens.com", required: true }),
              expect.objectContaining({ name: "上報", site: "upmedia.mg", required: true }),
              expect.objectContaining({ name: "商業周刊", site: "businessweekly.com.tw", required: true }),
              expect.objectContaining({ name: "天下雜誌", site: "cw.com.tw", required: true }),
              expect.objectContaining({ name: "今周刊", site: "businesstoday.com.tw", required: true }),
              expect.objectContaining({ name: "財訊", site: "wealth.com.tw", required: true }),
              expect.objectContaining({ name: "MoneyDJ理財網", site: "moneydj.com", required: true }),
              expect.objectContaining({ name: "鉅亨網", site: "news.cnyes.com", required: true }),
            ]),
          }),
        ]),
        priority_site_gaps: expect.any(Array),
      });
      expect(rssPackCoverageJson.summary.configured_pack_count).toBeGreaterThan(0);
      expect(rssPackCoverageJson.summary.priority_site_count).toBeGreaterThanOrEqual(16);

      const followupPreview = await backend.app.request("/api/sentiment/collection-jobs/recoverable-followups?limit=10&include_deep_crawl=0&include_social_followup=0&include_access_barrier_alternates=0&include_rss_priority_site_gaps=1");
      expect(followupPreview.status).toBe(200);
      const followupPreviewJson = await followupPreview.json();
      expect(followupPreviewJson.summary).toMatchObject({
        rss_priority_site_gap_jobs: expect.any(Number),
        rss_priority_site_empty_recovery_jobs: expect.any(Number),
        rss_priority_site_stale_refresh_jobs: expect.any(Number),
        rss_priority_site_dual_index_jobs: expect.any(Number),
      });
      if (followupPreviewJson.jobs.some(job => job.metadata?.task_type === "rss-priority-site-gap")) {
        expect(followupPreviewJson.jobs).toEqual(expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              recovery_index_engines: ["google-news", "bing-news"],
              recovery_index_feed_count: 2,
            }),
          }),
        ]));
      }

      const followupRecovery = await backend.app.request("/api/sentiment/collection-jobs/rss-priority-site-gap-recovery?days=30");
      expect(followupRecovery.status).toBe(200);
      expect(await followupRecovery.json()).toMatchObject({
        ok: true,
        summary: {
          tracked_site_count: expect.any(Number),
          job_count: expect.any(Number),
          recovered_site_count: expect.any(Number),
          stale_site_count: expect.any(Number),
          still_empty_site_count: expect.any(Number),
          empty_recovery_site_count: expect.any(Number),
          stale_refresh_site_count: expect.any(Number),
          runtime_recovery_site_count: expect.any(Number),
          runtime_unhealthy_feed_count: expect.any(Number),
          dual_index_site_count: expect.any(Number),
          requested_index_feed_count: expect.any(Number),
          failed_index_site_count: expect.any(Number),
          failed_index_feed_count: expect.any(Number),
          inserted_count: expect.any(Number),
        },
        sites: expect.any(Array),
      });

      const sourceFamilyRefreshRecovery = await backend.app.request("/api/sentiment/collection-jobs/rss-source-family-refresh-recovery?days=30");
      expect(sourceFamilyRefreshRecovery.status).toBe(200);
      expect(await sourceFamilyRefreshRecovery.json()).toMatchObject({
        ok: true,
        summary: {
          tracked_group_count: expect.any(Number),
          job_count: expect.any(Number),
          pending_count: expect.any(Number),
          running_count: expect.any(Number),
          success_count: expect.any(Number),
          failed_count: expect.any(Number),
          inserted_count: expect.any(Number),
          diagnostic_inserted_count: expect.any(Number),
          diagnostic_failure_count: expect.any(Number),
          requested_pack_count: expect.any(Number),
          failed_target_count: expect.any(Number),
          current_required_group_count: expect.any(Number),
          observed_group_count: expect.any(Number),
          attempted_group_count: expect.any(Number),
          not_started_group_count: expect.any(Number),
          source_family_count: expect.any(Number),
          mode_count: expect.any(Number),
          refreshed_source_families: expect.any(Array),
          recommended_action_counts: expect.any(Object),
        },
        groups: expect.any(Array),
      });

      const nativePromotionEffectiveness = await backend.app.request("/api/sentiment/rss-feed-pack-coverage/native-entry-promotion-effectiveness?days=30");
      expect(nativePromotionEffectiveness.status).toBe(200);
      expect(await nativePromotionEffectiveness.json()).toMatchObject({
        ok: true,
        summary: {
          promoted_feed_count: expect.any(Number),
          productive_feed_count: expect.any(Number),
          stale_feed_count: expect.any(Number),
          empty_feed_count: expect.any(Number),
          evidence_count: expect.any(Number),
          high_relevance_feed_count: expect.any(Number),
          high_quality_feed_count: expect.any(Number),
          pack_count: expect.any(Number),
          site_count: expect.any(Number),
        },
        feeds: expect.any(Array),
      });

      const nativePromotionRefresh = await backend.app.request("/api/sentiment/collection-jobs/rss-native-entry-promotion-refresh?days=30");
      expect(nativePromotionRefresh.status).toBe(200);
      expect(await nativePromotionRefresh.json()).toMatchObject({
        ok: true,
        summary: {
          promoted_feed_count: expect.any(Number),
          productive_feed_count: expect.any(Number),
          stale_feed_count: expect.any(Number),
          empty_feed_count: expect.any(Number),
          refresh_job_count: expect.any(Number),
          highest_priority: expect.any(Number),
        },
        jobs: expect.any(Array),
      });

      const nativePromotionRefreshRecovery = await backend.app.request("/api/sentiment/collection-jobs/rss-native-entry-promotion-refresh-recovery?days=30");
      expect(nativePromotionRefreshRecovery.status).toBe(200);
      expect(await nativePromotionRefreshRecovery.json()).toMatchObject({
        ok: true,
        summary: {
          tracked_feed_count: expect.any(Number),
          job_count: expect.any(Number),
          pending_count: expect.any(Number),
          running_count: expect.any(Number),
          success_count: expect.any(Number),
          partial_count: expect.any(Number),
          failed_count: expect.any(Number),
          recovered_feed_count: expect.any(Number),
          inserted_pending_feed_count: expect.any(Number),
          not_recovered_feed_count: expect.any(Number),
          inserted_count: expect.any(Number),
          requested_candidate_count: expect.any(Number),
          failed_candidate_count: expect.any(Number),
        },
        feeds: expect.any(Array),
      });

      const nativePromotionGovernance = await backend.app.request("/api/sentiment/rss-feed-pack-coverage/native-entry-promotion-governance?days=30");
      expect(nativePromotionGovernance.status).toBe(200);
      expect(await nativePromotionGovernance.json()).toMatchObject({
        ok: true,
        summary: {
          promoted_feed_count: expect.any(Number),
          keep_count: expect.any(Number),
          refresh_count: expect.any(Number),
          monitor_count: expect.any(Number),
          manual_review_count: expect.any(Number),
          bad_count: expect.any(Number),
          warn_count: expect.any(Number),
          good_count: expect.any(Number),
        },
        feeds: expect.any(Array),
      });

      const nativePromotionGovernanceApply = await backend.app.request("/api/sentiment/rss-feed-pack-coverage/native-entry-promotion-governance/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply: false, days: 30, disable: false }),
      });
      expect(nativePromotionGovernanceApply.status).toBe(200);
      expect(await nativePromotionGovernanceApply.json()).toMatchObject({
        ok: true,
        applied: false,
        disable_applied: false,
        summary: {
          target_feed_count: expect.any(Number),
          marked_feed_count: expect.any(Number),
          disabled_feed_count: expect.any(Number),
          governance_feed_count: expect.any(Number),
          manual_review_count: expect.any(Number),
        },
        targets: expect.any(Array),
      });

      const taiwanMediaHealth = await backend.app.request("/api/sentiment/rss-feed-pack-coverage/taiwan-media-health?limit=50");
      expect(taiwanMediaHealth.status).toBe(200);
      expect(await taiwanMediaHealth.json()).toMatchObject({
        ok: true,
        pack_key: "taiwanMedia",
        summary: {
          site_count: 16,
          missing_site_count: 0,
          dual_index_ready_site_count: 16,
          native_entry_site_count: expect.any(Number),
          sitemap_entry_site_count: expect.any(Number),
        },
        sites: expect.arrayContaining([
          expect.objectContaining({
            name: "上報",
            has_native_entry: true,
            sitemap_entry_count: 1,
            recommended_action: "keep-monitoring",
          }),
        ]),
      });

      const taiwanPublicInterestHealth = await backend.app.request("/api/sentiment/rss-feed-pack-coverage/taiwan-public-interest-health?limit=50");
      expect(taiwanPublicInterestHealth.status).toBe(200);
      expect(await taiwanPublicInterestHealth.json()).toMatchObject({
        ok: true,
        pack_key: "taiwanPublicInterest",
        summary: {
          site_count: 8,
          missing_site_count: 0,
          dual_index_ready_site_count: 8,
          native_entry_site_count: expect.any(Number),
        },
        sites: expect.arrayContaining([
          expect.objectContaining({
            name: "中央社",
            recommended_action: expect.any(String),
          }),
          expect.objectContaining({
            name: "報導者",
            dual_index_ready: true,
          }),
        ]),
      });

      const taiwanNativeDiscoveryPreview = await backend.app.request("/api/sentiment/collection-jobs/recoverable-followups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apply: false,
          days: 30,
          limit: 40,
          includeDeepCrawl: false,
          includeSocialFollowup: false,
          includeAccessBarrierAlternates: false,
          includeRssPrioritySiteGaps: false,
          includeRssNativeEntryDiscovery: true,
          includeEvidenceCoverageFollowups: false,
        }),
      });
      expect(taiwanNativeDiscoveryPreview.status).toBe(200);
      expect(await taiwanNativeDiscoveryPreview.json()).toMatchObject({
        ok: true,
        applied: false,
        summary: {
          rss_native_entry_discovery_jobs: expect.any(Number),
          rss_native_entry_discovery_unattempted_jobs: expect.any(Number),
          rss_native_entry_discovery_recent_attempt_jobs: expect.any(Number),
          rss_native_entry_discovery_pack_group_count: expect.any(Number),
          rss_native_entry_discovery_pack_groups: expect.any(Array),
        },
        jobs: expect.arrayContaining([
          expect.objectContaining({
            sourceKey: "rssFeeds",
            reason: "recoverable-rss-native-entry-discovery",
          }),
          expect.objectContaining({
            sourceKey: "rssFeeds",
            reason: "recoverable-rss-native-entry-discovery",
            entity: expect.objectContaining({
              pack_key: "taiwanPublicInterest",
              site_name: "中央社",
              site: "cna.com.tw",
            }),
          }),
        ]),
      });

      const taiwanNativeDiscoveryRecovery = await backend.app.request("/api/sentiment/collection-jobs/rss-native-entry-discovery-recovery?days=30&limit=100");
      expect(taiwanNativeDiscoveryRecovery.status).toBe(200);
      expect(await taiwanNativeDiscoveryRecovery.json()).toMatchObject({
        ok: true,
        summary: {
          tracked_site_count: expect.any(Number),
          pack_group_count: expect.any(Number),
          job_count: expect.any(Number),
          success_count: expect.any(Number),
          failed_count: expect.any(Number),
          recovered_native_entry_site_count: expect.any(Number),
          still_missing_native_entry_site_count: expect.any(Number),
          not_started_missing_native_entry_site_count: expect.any(Number),
          inserted_count: expect.any(Number),
        },
        pack_groups: expect.any(Array),
        sites: expect.any(Array),
      });

      const health = await backend.app.request("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, status: "ok" });

      const settingsResponse = await backend.app.request("/api/sentiment/search-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sources: ["googleNews", "threads"],
          proxyEnabled: false,
          rssFeedPacks: {
            fast: ["consumerProtection"],
            full: ["taiwanMedia", "greaterChinaMedia"],
            watch: ["pressReleases"],
          },
        }),
      });
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toMatchObject({
        settings: {
          sources: ["googleNews", "threads"],
          proxyEnabled: false,
          rssFeedPacks: {
            fast: ["consumerProtection"],
            full: ["taiwanMedia", "greaterChinaMedia"],
            watch: ["pressReleases"],
          },
        },
      });

      const openSearchSettingsResponse = await backend.app.request("/api/sentiment/opensearch-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          accessMode: "dashboardsProxy",
          endpoint: "http://opensearch-dashboards.example.test:5601",
          username: "admin",
          password: "secret-password",
          indexName: "sentiment_high_value_evidence",
          minArchiveScore: 70,
          maintenance: {
            enabled: true,
            retentionDays: 730,
            noiseRetentionDays: 60,
            duplicateLookbackDays: 120,
            minKeepScore: 75,
            maxDeletePerRun: 500,
          },
        }),
      });
      expect(openSearchSettingsResponse.status).toBe(200);
      expect(await openSearchSettingsResponse.json()).toMatchObject({
        settings: {
          enabled: true,
          accessMode: "dashboardsProxy",
          endpoint: "http://opensearch-dashboards.example.test:5601",
          password: "***",
          configured: true,
          maintenance: {
            enabled: true,
            retentionDays: 730,
            noiseRetentionDays: 60,
            duplicateLookbackDays: 120,
            minKeepScore: 75,
            maxDeletePerRun: 500,
          },
        },
      });

      const revealedOpenSearchSettingsResponse = await backend.app.request("/api/sentiment/opensearch-settings?reveal=1");
      expect(revealedOpenSearchSettingsResponse.status).toBe(200);
      const revealedOpenSearchSettings = await revealedOpenSearchSettingsResponse.json();
      expect(revealedOpenSearchSettings.settings.password).toBe("secret-password");
      expect(revealedOpenSearchSettings.settings.configured).toBe(true);

      const aiSettingsResponse = await backend.app.request("/api/sentiment/ai-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          baseUrl: "https://ai.example.test/v1",
          apiKey: "sk-test-secret",
          model: "report-model",
        }),
      });
      expect(aiSettingsResponse.status).toBe(200);

      const revealedAiSettingsResponse = await backend.app.request("/api/sentiment/ai-settings?reveal=1");
      expect(revealedAiSettingsResponse.status).toBe(200);
      const revealedAiSettings = await revealedAiSettingsResponse.json();
      expect(revealedAiSettings.settings.apiKey).toBe("sk-test-secret");
      expect(revealedAiSettings.settings.configured).toBe(true);

      const expansionFetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          translations: [{ locale: "ja", term: "オピンエックス" }],
          expanded_keywords: ["OpinX refund"],
          risk_queries: ["OpinX data breach"],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", expansionFetch);
      const realtimeExpansionResponse = await backend.app.request("/api/sentiment/keyword-expansion/realtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keywords: ["OpinX"],
          mode: "fast",
          limit: 20,
          forceRefresh: true,
        }),
      });
      expect(realtimeExpansionResponse.status).toBe(200);
      expect(await realtimeExpansionResponse.json()).toEqual(expect.objectContaining({
        ok: true,
        source: "ai",
        keywords: expect.arrayContaining(["OpinX", "オピンエックス", "OpinX data breach"]),
      }));

      const configResponse = await backend.app.request("/api/config");
      expect(configResponse.status).toBe(200);
      const config = await configResponse.json();
      expect(config.config.sentimentAi.apiKey).toBe("sk-***cret");
      expect(config.config.sentimentSearch.openSearch.password).toBe("***");

      const keywordResponse = await backend.app.request("/api/sentiment/keywords", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: "捐款 客服" }),
      });
      expect(keywordResponse.status).toBe(201);
      expect(await keywordResponse.json()).toMatchObject({
        keywords: ["捐款", "客服"],
        inserted: 2,
      });

      const ingestResponse = await backend.app.request("/api/sentiment/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_type: "manual",
          items: [{
            platform: "news",
            url: "https://example.test/sentiment",
            title: "台灣捐款服務討論",
            content: "台灣公益捐款客服流程被公開討論。",
            keyword: "捐款",
            sentiment: "neutral",
            published_at: new Date().toISOString(),
          }],
        }),
      });
      expect(ingestResponse.status).toBe(201);
      expect(await ingestResponse.json()).toMatchObject({ ok: true, inserted: 1 });

      const dashboard = await backend.app.request("/api/sentiment/dashboard");
      expect(dashboard.status).toBe(200);
      const dashboardJson = await dashboard.json();
      expect(dashboardJson.stats.total).toBe(1);
      expect(dashboardJson.items[0].title).toBe("台灣捐款服務討論");

      expect(fs.existsSync(path.join(dataDir, "crm.db"))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, "sentiment-config.json"))).toBe(true);
    } finally {
      backend.close();
    }
  });
});
