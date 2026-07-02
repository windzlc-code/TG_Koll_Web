import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

import sentimentRoutes from "../../../plugins/sentiment/routes/sentiment.js";
import { closeDb, initDb } from "../../../plugins/sentiment/db/db.js";
import {
  ensureSentimentOperationalDefaults,
  maskSentimentAiSettings,
  maskSentimentOpenSearchSettings,
  readSentimentAiSettings,
  readSentimentNotificationSettings,
  readSentimentSearchSettings,
} from "../../../plugins/sentiment/sentiment-store.js";
import {
  configureSentimentRunner,
  getSentimentMonitorStatus,
  startSentimentScheduler,
  stopSentimentScheduler,
} from "../../../plugins/sentiment/scrapers/runner.js";
import { JsonConfigStore } from "./config-store.js";

const DEFAULT_PORT = 8787;
const DEFAULT_INTERVAL_MINUTES = 5;
const CONTINUOUS_WORKER_STALE_HEARTBEAT_MS = 2 * 60 * 1000;
const DEFAULT_ADMIN_SETTINGS = {
  scanDays: 30,
  reportDays: 30,
  sourceScopes: {
    fast: [],
    full: [],
    watch: [],
  },
};
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function resolveDataDir(input = "") {
  const raw = String(input || process.env.SENTIMENT_DATA_DIR || "").trim();
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".opinx-sentiment");
}

function createLogger() {
  return {
    info: (...args) => console.log("[sentiment-backend]", ...args),
    warn: (...args) => console.warn("[sentiment-backend]", ...args),
    error: (...args) => console.error("[sentiment-backend]", ...args),
  };
}

function createBus(log = createLogger()) {
  return {
    events: [],
    emit(event) {
      this.events.push({ ...event, emitted_at: new Date().toISOString() });
      if (event?.type) log.info("event", event.type);
    },
  };
}

function jsonError(c, error, status = 500) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return c.json({ ok: false, error: message }, status);
}

function readPublicFile(relativePath = "index.html") {
  const safePath = String(relativePath || "index.html").replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, safePath);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== PUBLIC_DIR) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return {
    body: fs.readFileSync(resolved),
    type: STATIC_TYPES.get(path.extname(resolved).toLowerCase()) || "application/octet-stream",
  };
}

function crc32Buffer(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createStoredZip(files = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name.replace(/^\/+/, ""), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");
    const crc = crc32Buffer(data);
    const { dosTime, dosDate } = dosDateTime(file.mtime || new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function buildBrowserAuthExtensionZip(config) {
  const baseDir = path.resolve(PUBLIC_DIR, "browser-auth-extension");
  const fileNames = ["manifest.json", "background.js", "popup.html", "popup.js", "install.html"];
  const files = fileNames.map((name) => {
    const filePath = path.resolve(baseDir, name);
    const stat = fs.statSync(filePath);
    const data = fs.readFileSync(filePath);
    return {
      name: `opinx-browser-auth-helper/${name}`,
      data,
      mtime: stat.mtime,
    };
  });
  return createStoredZip(files);
}

function normalizeAdminSourceList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || "").trim()).filter(Boolean))].slice(0, 300);
}

function normalizeAdminSourceScopes(input = {}) {
  const scopes = input?.sourceScopes || input?.source_scopes || {};
  return {
    fast: normalizeAdminSourceList(scopes.fast || scopes.quick || scopes.quickScan),
    full: normalizeAdminSourceList(scopes.full || scopes.depth || scopes.deep || scopes.fullScan),
    watch: normalizeAdminSourceList(scopes.watch || scopes.crisis || scopes.warning || scopes.watchScan),
  };
}

function normalizeAdminSettings(input = {}) {
  return {
    scanDays: Math.max(1, Math.min(365, Number(input.scanDays ?? input.scan_days ?? DEFAULT_ADMIN_SETTINGS.scanDays) || DEFAULT_ADMIN_SETTINGS.scanDays)),
    reportDays: Math.max(1, Math.min(365, Number(input.reportDays ?? input.report_days ?? DEFAULT_ADMIN_SETTINGS.reportDays) || DEFAULT_ADMIN_SETTINGS.reportDays)),
    sourceScopes: normalizeAdminSourceScopes(input),
  };
}

function createContinuousRunId() {
  return `continuous-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createWorkerRunId(prefix = "worker") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function publicContinuousRunView(run = null) {
  if (!run || typeof run !== "object") return null;
  return {
    id: run.id || "",
    status: run.status || "unknown",
    accepted: run.accepted !== false,
    mode: run.mode || "fast",
    created_at: run.created_at || null,
    started_at: run.started_at || null,
    finished_at: run.finished_at || null,
    duration_ms: run.duration_ms ?? null,
    heartbeat_at: run.heartbeat_at || null,
    heartbeat_elapsed_ms: run.heartbeat_elapsed_ms ?? null,
    options: run.options || {},
    result: compactContinuousRunResult(run.result),
    result_full_available: Boolean(run.result),
    error: run.error || "",
    worker: run.worker || null,
  };
}

function compactJobResult(result = null) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: result.ok !== false,
    executed: Number(result.executed || 0),
    total: Number(result.total || 0),
    events: Number(result.events || 0),
    alerts: Number(result.alerts || 0),
    reason: result.reason || "",
    job_count: Array.isArray(result.jobs) ? result.jobs.length : 0,
  };
}

function compactContinuousRunResult(result = null) {
  if (!result || typeof result !== "object") return null;
  if (result.deferred === true) {
    return {
      ok: result.ok !== false,
      deferred: true,
      reason: result.reason || "",
      mode: result.mode || "",
      sourceCoverageRefreshStage: result.sourceCoverageRefreshStage || null,
    };
  }
  const collectionJobRun = Boolean(result.dueJobSelection || result.backlog_drain);
  return {
    ok: result.ok !== false,
    type: collectionJobRun ? "collection-jobs-execute-due" : "continuous-collection",
    deferred: false,
    mode: result.mode || result.plan?.mode || "",
    collectionJobResult: collectionJobRun
      ? {
        ...compactJobResult(result),
        dueJobSelection: result.dueJobSelection || null,
        backlogDrain: result.backlog_drain || null,
      }
      : null,
    executed_scan_sources: Array.isArray(result.executed_scan_sources) ? result.executed_scan_sources.slice(0, 50) : [],
    executed_scan_source_count: Array.isArray(result.executed_scan_sources) ? result.executed_scan_sources.length : 0,
    collectionJobBacklogDrain: result.collectionJobBacklogDrain || null,
    retryStage: result.retryStage || null,
    scanStage: result.scanStage || null,
    sourceCoverageRefreshStage: result.sourceCoverageRefreshStage || null,
    retryResult: compactJobResult(result.retryResult),
    sourceCoverageRefreshFollowupResult: compactJobResult(result.sourceCoverageRefreshFollowupResult),
    freeSourceTargetCoverageFollowupResult: compactJobResult(result.freeSourceTargetCoverageFollowupResult),
    deepCrawlChainGapFollowupResult: compactJobResult(result.deepCrawlChainGapFollowupResult),
    postScanFollowupResult: compactJobResult(result.postScanFollowupResult),
    postScanSourceFamilyCoverageFollowupResult: compactJobResult(result.postScanSourceFamilyCoverageFollowupResult),
    searchIndexMaintenanceResult: result.searchIndexMaintenanceResult
      ? {
        ok: result.searchIndexMaintenanceResult.ok !== false,
        updated: Number(result.searchIndexMaintenanceResult.updated || result.searchIndexMaintenanceResult.updated_count || 0),
        reason: result.searchIndexMaintenanceResult.reason || "",
      }
      : null,
    openSearchArchiveSyncResult: result.openSearchArchiveSyncResult
      ? {
        ok: result.openSearchArchiveSyncResult.ok !== false,
        synced: Number(result.openSearchArchiveSyncResult.synced || result.openSearchArchiveSyncResult.synced_count || 0),
        reason: result.openSearchArchiveSyncResult.reason || "",
      }
      : null,
  };
}

function readJsonFile(filePath = "") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid = 0) {
  const value = Number(pid || 0);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

export function createSentimentBackendApp({
  dataDir = resolveDataDir(),
  configPath = "",
  enableScheduler = process.env.SENTIMENT_SCHEDULER === "1" || process.env.SENTIMENT_SCHEDULER === "true",
  intervalMinutes = Number(process.env.SENTIMENT_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES),
  log = createLogger(),
  bus = createBus(log),
} = {}) {
  const resolvedDataDir = resolveDataDir(dataDir);
  fs.mkdirSync(resolvedDataDir, { recursive: true });
  initDb(resolvedDataDir);
  ensureSentimentOperationalDefaults();

  const config = new JsonConfigStore(configPath || path.join(resolvedDataDir, "sentiment-config.json"));
  const continuousRunDir = path.join(resolvedDataDir, "continuous-runs");
  let scanChild = null;
  let continuousChild = null;
  let collectionJobChild = null;
  const startBackgroundScan = (job = {}) => {
    if (scanChild && scanChild.exitCode === null && scanChild.signalCode === null) return scanChild.pid;
    const child = spawn(process.execPath, [path.join(SRC_DIR, "scan-worker.js")], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SENTIMENT_DATA_DIR: resolvedDataDir,
        SENTIMENT_CONFIG_PATH: config.filePath,
        SENTIMENT_SCAN_JOB: JSON.stringify(job),
      },
    });
    scanChild = child;
    child.once("exit", () => {
      if (scanChild === child) scanChild = null;
    });
    child.unref();
    return child.pid;
  };
  const isBackgroundScanRunning = () => Boolean(scanChild && scanChild.exitCode === null && scanChild.signalCode === null);
  const continuousRunPath = (runId = "") => path.join(continuousRunDir, `${String(runId || "").replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
  const writeContinuousRun = (run = {}) => {
    fs.mkdirSync(continuousRunDir, { recursive: true });
    fs.writeFileSync(continuousRunPath(run.id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    return run;
  };
  const reconcileContinuousRun = (run = null) => {
    if (!run || typeof run !== "object") return run;
    if (!["queued", "running"].includes(run.status)) return run;
    const pid = run.worker?.pid;
    const alive = isPidAlive(pid);
    const heartbeatAt = Date.parse(run.heartbeat_at || run.started_at || run.created_at || 0);
    const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Date.now() - heartbeatAt : Infinity;
    if (alive && heartbeatAgeMs <= CONTINUOUS_WORKER_STALE_HEARTBEAT_MS) return run;
    const next = {
      ...run,
      status: "failed",
      finished_at: new Date().toISOString(),
      duration_ms: run.started_at ? Math.max(0, Date.now() - Date.parse(run.started_at)) : run.duration_ms,
      error: alive
        ? `continuous collection worker heartbeat stale for ${Math.max(0, Math.round(heartbeatAgeMs / 1000))}s`
        : `continuous collection worker process not running: pid=${pid || ""}`,
      worker: {
        ...(run.worker || {}),
        alive,
        stale_heartbeat: alive,
        heartbeat_age_ms: Number.isFinite(heartbeatAgeMs) ? Math.max(0, heartbeatAgeMs) : null,
      },
    };
    writeContinuousRun(next);
    return next;
  };
  const getBackgroundContinuousCollectionRun = (runId = "") => {
    const run = reconcileContinuousRun(readJsonFile(continuousRunPath(runId)));
    return {
      ok: Boolean(run),
      run: publicContinuousRunView(run),
    };
  };
  const listBackgroundContinuousCollectionRuns = ({ limit = 20 } = {}) => {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    let runs = [];
    try {
      runs = fs.readdirSync(continuousRunDir)
        .filter(name => name.endsWith(".json"))
        .map(name => reconcileContinuousRun(readJsonFile(path.join(continuousRunDir, name))))
        .filter(Boolean);
    } catch {
      runs = [];
    }
    return {
      ok: true,
      runs: runs
        .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
        .slice(0, safeLimit)
        .map(publicContinuousRunView),
    };
  };
  const isBackgroundContinuousCollectionRunning = () => Boolean(continuousChild && continuousChild.exitCode === null && continuousChild.signalCode === null);
  const isBackgroundCollectionJobExecutionRunning = () => Boolean(collectionJobChild && collectionJobChild.exitCode === null && collectionJobChild.signalCode === null);
  const startWorkerRun = ({ type = "continuous-collection", idPrefix = "worker", options = {}, allowConcurrent = false, childRef = () => null, setChildRef = () => {} } = {}) => {
    const activeChild = childRef();
    if (!allowConcurrent && activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      return {
        ok: true,
        accepted: false,
        already_running: true,
        reason: `${type}-worker-already-running`,
        run: publicContinuousRunView(readJsonFile(activeChild.__opinxRunPath || "")),
      };
    }
    const runId = createWorkerRunId(idPrefix);
    const now = new Date().toISOString();
    const run = writeContinuousRun({
      id: runId,
      type,
      status: "queued",
      accepted: true,
      mode: options.mode || "fast",
      created_at: now,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      options: {
        ...options,
        searchSettings: options.searchSettings ? "[route-search-settings]" : null,
        log: undefined,
      },
      result: null,
      error: "",
      worker: {
        external_process: true,
        pid: null,
        type,
      },
    });
    const child = spawn(process.execPath, [path.join(SRC_DIR, "scan-worker.js")], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SENTIMENT_DATA_DIR: resolvedDataDir,
        SENTIMENT_CONFIG_PATH: config.filePath,
        SENTIMENT_SCAN_JOB: JSON.stringify({
          type,
          runId,
          statusPath: continuousRunPath(runId),
          options,
        }),
      },
    });
    child.__opinxRunPath = continuousRunPath(runId);
    setChildRef(child);
    run.worker.pid = child.pid;
    writeContinuousRun(run);
    child.once("exit", (code, signal) => {
      const latest = readJsonFile(continuousRunPath(runId)) || run;
      if (latest.status === "queued" || latest.status === "running") {
        writeContinuousRun({
          ...latest,
          status: code === 0 ? "success" : "failed",
          finished_at: new Date().toISOString(),
          error: code === 0 ? "" : `worker exited before completion: code=${code ?? ""} signal=${signal ?? ""}`,
        });
      }
      if (childRef() === child) setChildRef(null);
    });
    child.unref();
    return {
      ok: true,
      accepted: true,
      already_running: false,
      run: publicContinuousRunView(run),
    };
  };
  const startBackgroundContinuousCollection = ({ options = {}, allowConcurrent = false } = {}) => {
    return startWorkerRun({
      type: "continuous-collection",
      idPrefix: "continuous",
      options,
      allowConcurrent,
      childRef: () => continuousChild,
      setChildRef: child => { continuousChild = child; },
    });
  };
  const startBackgroundCollectionJobExecution = ({ options = {}, allowConcurrent = false } = {}) => {
    return startWorkerRun({
      type: "collection-jobs-execute-due",
      idPrefix: "collection-jobs",
      options,
      allowConcurrent,
      childRef: () => collectionJobChild,
      setChildRef: child => { collectionJobChild = child; },
    });
  };
  configureSentimentRunner({
    bus,
    log,
    aiSettings: () => readSentimentAiSettings(config),
    notificationSettings: () => readSentimentNotificationSettings(config),
    searchSettings: () => readSentimentSearchSettings(config),
  });

  if (enableScheduler) {
    const minutes = Math.max(1, Math.min(24 * 60, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES));
    startSentimentScheduler({ intervalMs: minutes * 60 * 1000 });
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginCtx", {
      config,
      bus,
      log,
      startBackgroundScan,
      isBackgroundScanRunning,
      startBackgroundContinuousCollection,
      startBackgroundCollectionJobExecution,
      getBackgroundContinuousCollectionRun,
      listBackgroundContinuousCollectionRuns,
      isBackgroundContinuousCollectionRunning,
      isBackgroundCollectionJobExecutionRunning,
    });
    await next();
  });

  app.get("/", (c) => {
    const file = readPublicFile("index.html");
    if (!file) return c.text("Sentiment web app is missing.", 500);
    return new Response(file.body, { headers: { "content-type": file.type } });
  });

  app.get("/admin", (c) => {
    const file = readPublicFile("admin.html");
    if (!file) return c.text("Sentiment admin page is missing.", 500);
    return new Response(file.body, { headers: { "content-type": file.type } });
  });

  app.get("/assets/:file", (c) => {
    const file = readPublicFile(c.req.param("file"));
    if (!file) return c.text("not found", 404);
    return new Response(file.body, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
  });

  app.get("/browser-auth-extension/download", () => {
    const zip = buildBrowserAuthExtensionZip(config);
    return new Response(zip, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": "attachment; filename=\"opinx-browser-auth-helper.zip\"",
        "cache-control": "no-cache",
      },
    });
  });

  app.get("/browser-auth-extension/:file", (c) => {
    const file = readPublicFile(`browser-auth-extension/${c.req.param("file")}`);
    if (!file) return c.text("not found", 404);
    return new Response(file.body, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
  });

  app.get("/api", (c) => c.json({
    ok: true,
    name: "opinx-sentiment-backend",
    dataDir: resolvedDataDir,
    endpoints: [
      "GET /health",
      "GET /api/sentiment",
      "POST /api/sentiment/scan",
      "POST /api/sentiment/scan-start",
      "GET /api/sentiment/report",
      "GET/POST/DELETE /api/sentiment/keywords",
      "GET/PUT /api/sentiment/search-settings",
      "GET/PUT /api/admin-settings",
      "POST /api/sentiment/ingest",
      "POST /api/sentiment/monitor",
    ],
  }));

  app.get("/health", (c) => c.json({
    ok: true,
    status: "ok",
    dataDir: resolvedDataDir,
    scheduler: {
      ...getSentimentMonitorStatus(),
      running: getSentimentMonitorStatus().running
        || isBackgroundScanRunning()
        || isBackgroundContinuousCollectionRunning()
        || isBackgroundCollectionJobExecutionRunning(),
    },
  }));

  app.get("/api/config", (c) => {
    const allConfig = config.all();
    return c.json({
      ok: true,
      config: {
        ...allConfig,
        sentimentAi: maskSentimentAiSettings(allConfig.sentimentAi || {}),
        sentimentSearch: {
          ...(allConfig.sentimentSearch || {}),
          openSearch: maskSentimentOpenSearchSettings(allConfig.sentimentSearch?.openSearch || {}),
        },
      },
    });
  });
  app.get("/api/admin-settings", (c) => c.json({
    ok: true,
    settings: normalizeAdminSettings(config.get("adminSettings") || {}),
  }));
  app.put("/api/admin-settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const current = normalizeAdminSettings(config.get("adminSettings") || {});
    const settings = normalizeAdminSettings({
      ...current,
      ...body,
      sourceScopes: body.sourceScopes || body.source_scopes || current.sourceScopes,
    });
    config.set("adminSettings", settings);
    return c.json({ ok: true, settings });
  });
  app.route("/api/sentiment", sentimentRoutes);

  app.onError((error, c) => jsonError(c, error));

  return {
    app,
    dataDir: resolvedDataDir,
    config,
    bus,
    log,
    close() {
      stopSentimentScheduler();
      closeDb();
    },
  };
}

export function startSentimentBackend(options = {}) {
  const port = Math.max(1, Math.min(65535, Number(options.port || process.env.PORT || DEFAULT_PORT)));
  const hostname = String(options.hostname || options.host || process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
  const backend = createSentimentBackendApp(options);
  const server = serve({ fetch: backend.app.fetch, port, hostname });
  backend.log?.info?.(`listening on http://${hostname}:${port}`);
  return {
    ...backend,
    port,
    hostname,
    server,
    close() {
      server.close?.();
      backend.close();
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const backend = startSentimentBackend();
  const shutdown = () => {
    backend.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
