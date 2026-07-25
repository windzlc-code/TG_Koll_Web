import fs from "node:fs";
import path from "node:path";
import { closeDb, initDb } from "../../../plugins/sentiment/db/db.js";
import {
  ensureSentimentOperationalDefaults,
  readSentimentAiSettings,
  readSentimentNotificationSettings,
  readSentimentSearchSettings,
} from "../../../plugins/sentiment/sentiment-store.js";
import {
  configureSentimentRunner,
  executeDueSentimentCollectionJobDrain,
  executeDueSentimentCollectionJobs,
  executeSentimentContinuousCollectionCycle,
  runSentimentScanNow,
} from "../../../plugins/sentiment/scrapers/runner.js";
import { JsonConfigStore } from "./config-store.js";

function parseJob() {
  try {
    return JSON.parse(process.env.SENTIMENT_SCAN_JOB || "{}");
  } catch {
    return {};
  }
}

function resolveWorkerTimeoutMs() {
  const configured = Number(process.env.SENTIMENT_SCAN_TIMEOUT_MS || 90_000);
  if (!Number.isFinite(configured)) return 90_000;
  return Math.max(30_000, Math.min(180_000, Math.floor(configured)));
}

function writeStatus(job = {}, patch = {}) {
  const statusPath = String(job.statusPath || job.status_path || "").trim();
  if (!statusPath) return;
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    current = {};
  }
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

const log = {
  info: (...args) => console.log("[sentiment-scan-worker]", ...args),
  warn: (...args) => console.warn("[sentiment-scan-worker]", ...args),
  error: (...args) => console.error("[sentiment-scan-worker]", ...args),
};

const bus = {
  emit(event) {
    if (event?.type) log.info("event", event.type);
  },
};

async function main() {
  const dataDir = process.env.SENTIMENT_DATA_DIR;
  const configPath = process.env.SENTIMENT_CONFIG_PATH;
  if (!dataDir || !configPath) throw new Error("SENTIMENT_DATA_DIR and SENTIMENT_CONFIG_PATH are required");

  initDb(dataDir);
  ensureSentimentOperationalDefaults();
  const config = new JsonConfigStore(configPath);
  configureSentimentRunner({
    bus,
    log,
    aiSettings: () => readSentimentAiSettings(config),
    notificationSettings: () => readSentimentNotificationSettings(config),
    searchSettings: () => readSentimentSearchSettings(config),
  });

  const job = parseJob();
  const startedAt = Date.now();
  const workerTimeoutMs = resolveWorkerTimeoutMs();
  writeStatus(job, {
    id: job.runId || job.run_id || null,
    status: "running",
    started_at: new Date(startedAt).toISOString(),
    heartbeat_at: new Date(startedAt).toISOString(),
    heartbeat_elapsed_ms: 0,
    error: "",
  });
  const heartbeat = setInterval(() => {
    writeStatus(job, {
      status: "running",
      heartbeat_at: new Date().toISOString(),
      heartbeat_elapsed_ms: Math.max(0, Date.now() - startedAt),
    });
  }, 5000);
  heartbeat.unref?.();
  const timeout = setTimeout(() => {
    const finishedAt = new Date().toISOString();
    const error = `后台情绪扫描超过 ${Math.round(workerTimeoutMs / 1000)} 秒，已终止以释放抓取资源。`;
    writeStatus(job, {
      status: "failed",
      result: null,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Date.parse(finishedAt) - startedAt),
      heartbeat_at: finishedAt,
      heartbeat_elapsed_ms: Math.max(0, Date.parse(finishedAt) - startedAt),
      error,
    });
    log.error(error);
    closeDb();
    process.exit(1);
  }, workerTimeoutMs);
  timeout.unref?.();
  try {
    let result = null;
    if (job.type === "continuous-collection") {
      if (job.options?.deferContinuousCollectionExecution === true) {
        result = {
          ok: true,
          deferred: true,
          reason: job.options.deferContinuousCollectionReason || "continuous-collection-execution-deferred",
          mode: job.options.mode || "fast",
          sourceCoverageRefreshStage: {
            timed_out: false,
            stage: "source-coverage-refresh-followups",
            timeout_ms: 0,
            skipped: true,
            deferred: true,
          },
        };
      } else {
        result = await executeSentimentContinuousCollectionCycle(job.options || {});
      }
    } else if (job.type === "collection-jobs-execute-due") {
      const { drainBatches, collectionJobTimeoutMs, limit, concurrency, ...collectionOptions } = job.options || {};
      const safeDrainBatches = Math.max(1, Math.min(5, Number(drainBatches) || 1));
      result = safeDrainBatches > 1
        ? await executeDueSentimentCollectionJobDrain({
          batches: safeDrainBatches,
          limit,
          concurrency,
          collectionJobTimeoutMs,
          collectionOptions,
        })
        : await executeDueSentimentCollectionJobs(job.options || {});
    } else {
      result = await runSentimentScanNow({
        reason: job.reason || "manual",
        mode: job.mode || "fast",
        sources: Array.isArray(job.sources) ? job.sources : null,
        days: job.days,
      });
    }
    const finishedAt = new Date().toISOString();
    writeStatus(job, {
      status: "success",
      result,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Date.parse(finishedAt) - startedAt),
      heartbeat_at: finishedAt,
      heartbeat_elapsed_ms: Math.max(0, Date.parse(finishedAt) - startedAt),
      error: "",
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    writeStatus(job, {
      status: "failed",
      result: null,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Date.parse(finishedAt) - startedAt),
      heartbeat_at: finishedAt,
      heartbeat_elapsed_ms: Math.max(0, Date.parse(finishedAt) - startedAt),
      error: error?.message || String(error),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
  }
}

main()
  .catch(error => {
    log.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
