import { ensureRuntimeApiConfig } from "@/runtime/node/ensure-runtime-config";
import { ensureRuntimeSecrets } from "@/runtime/node/ensure-runtime-secrets";
import { PublishSchedulerService, recoverInterruptedPublishQueue, type PublishTaskRunResult } from "@/core/publish/publish-scheduler";
import { createNodePublishQueueRepository } from "@/runtime/node/publish-queue-repository";
import { startTelegramBot, stopTelegramPolling, type TelegramBotInstanceOptions } from "@/telegram-bot";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import fs from "node:fs";

const LOG_PREFIX = "[daemon]";
const TELEGRAM_BOT_DISABLED = process.env.TELEGRAM_BOT_DISABLED === "1";
const TELEGRAM_TOKEN_FILE = resolveRuntimeFile("telegram_bot_token.txt");
const TELEGRAM_BOTS_FILE = resolveRuntimeFile("telegram_bots.local.json");
const TELEGRAM_LOCK_FILE = resolveRuntimeFile("telegram_bot.lock");
const DAEMON_HEARTBEAT_FILE = resolveRuntimeFile("daemon.heartbeat.json");
const PROCESS_STATUS_FILE = resolveRuntimeFile("process-status.json");
const DAEMON_HEARTBEAT_STALE_MS = 90_000;
const TELEGRAM_BOT_CONFIG_RELOAD_MS = Math.max(Number(process.env.TELEGRAM_BOT_CONFIG_RELOAD_MS || 5000), 2000);

type TelegramBotRuntimeConfig = TelegramBotInstanceOptions & { token: string };

let activeTelegramBots: Array<{ config: TelegramBotRuntimeConfig; bot: ReturnType<typeof startTelegramBot> }> = [];
let activeTelegramBotSignature = "";
let telegramBotLockClaimed = false;

function readLocalTelegramBotToken(): string {
  try {
    if (!fs.existsSync(TELEGRAM_TOKEN_FILE)) return "";
    return fs.readFileSync(TELEGRAM_TOKEN_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

function normalizeTelegramBotConfig(value: any, fallbackName: string): TelegramBotRuntimeConfig | null {
  const token = String(value?.token || value?.botToken || "").trim();
  if (!token) return null;
  return {
    token,
    name: String(value?.name || fallbackName).trim() || fallbackName,
    defaultPublishPlatform: value?.defaultPublishPlatform,
    defaultWarmupPlatform: value?.defaultWarmupPlatform,
    allowedPublishPlatforms: Array.isArray(value?.allowedPublishPlatforms) ? value.allowedPublishPlatforms : undefined,
    allowedWarmupPlatforms: Array.isArray(value?.allowedWarmupPlatforms) ? value.allowedWarmupPlatforms : undefined,
  };
}

function readTelegramBotConfigsFromJson(raw: string): TelegramBotRuntimeConfig[] {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bots) ? parsed.bots : [];
  return list
    .map((item: any, index: number) => normalizeTelegramBotConfig(item, `bot-${index + 1}`))
    .filter((item: TelegramBotRuntimeConfig | null): item is TelegramBotRuntimeConfig => Boolean(item?.token));
}

function readLocalTelegramBotConfigs(): TelegramBotRuntimeConfig[] {
  if (TELEGRAM_BOT_DISABLED) return [];

  const envConfigs = String(process.env.TELEGRAM_BOTS_JSON || "").trim();
  if (envConfigs) {
    try {
      const parsed = readTelegramBotConfigsFromJson(envConfigs);
      if (parsed.length) return parsed;
    } catch (error: any) {
      log(`Failed to parse TELEGRAM_BOTS_JSON: ${error?.message || String(error)}`);
    }
  }

  try {
    if (fs.existsSync(TELEGRAM_BOTS_FILE)) {
      const parsed = readTelegramBotConfigsFromJson(fs.readFileSync(TELEGRAM_BOTS_FILE, "utf-8"));
      if (parsed.length) return parsed;
    }
  } catch (error: any) {
    log(`Failed to read Telegram bot config: ${error?.message || String(error)}`);
  }

  const token = (readLocalTelegramBotToken() || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  return token ? [{ token, name: "primary" }] : [];
}

function readDaemonHeartbeat(): { pid?: number; updatedAt?: string } | null {
  try {
    if (!fs.existsSync(DAEMON_HEARTBEAT_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(DAEMON_HEARTBEAT_FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isFreshDaemonHeartbeatForPid(pid: number): boolean {
  const heartbeat = readDaemonHeartbeat();
  if (Number(heartbeat?.pid) !== pid) return false;
  const updatedAt = Date.parse(String(heartbeat?.updatedAt || ""));
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= DAEMON_HEARTBEAT_STALE_MS;
}

function canStartTelegramBot(): boolean {
  try {
    if (!fs.existsSync(TELEGRAM_LOCK_FILE)) return true;
    const raw = fs.readFileSync(TELEGRAM_LOCK_FILE, "utf-8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      if (pid === process.pid) return true;
      return !isFreshDaemonHeartbeatForPid(pid);
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

function claimTelegramBotLock() {
  try {
    fs.writeFileSync(TELEGRAM_LOCK_FILE, String(process.pid), "utf-8");
  } catch {}
}

function releaseTelegramBotLock() {
  try {
    if (!fs.existsSync(TELEGRAM_LOCK_FILE)) return;
    const raw = fs.readFileSync(TELEGRAM_LOCK_FILE, "utf-8").trim();
    if (Number(raw) === process.pid) fs.unlinkSync(TELEGRAM_LOCK_FILE);
  } catch {}
}

function writeDaemonHeartbeat(extra: Record<string, unknown> = {}) {
  const state = String(extra.state || "running");
  const now = new Date();
  try {
    fs.writeFileSync(
      DAEMON_HEARTBEAT_FILE,
      JSON.stringify({ pid: process.pid, updatedAt: now.toISOString(), ...extra }, null, 2),
      "utf-8",
    );
  } catch {}
  try {
    fs.writeFileSync(
      PROCESS_STATUS_FILE,
      JSON.stringify({ state, pid: String(process.pid), updated_at: now.toISOString() }, null, 2),
      "utf-8",
    );
  } catch {}
}

function removeDaemonHeartbeat() {
  try {
    if (!fs.existsSync(DAEMON_HEARTBEAT_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DAEMON_HEARTBEAT_FILE, "utf-8"));
    if (Number(raw?.pid) === process.pid) fs.unlinkSync(DAEMON_HEARTBEAT_FILE);
  } catch {}
}

function telegramBotConfigSignature(configs: TelegramBotRuntimeConfig[]): string {
  return JSON.stringify(configs.map((config) => ({
    token: config.token,
    name: config.name || "primary",
    defaultPublishPlatform: config.defaultPublishPlatform || "",
    defaultWarmupPlatform: config.defaultWarmupPlatform || "",
    allowedPublishPlatforms: config.allowedPublishPlatforms || [],
    allowedWarmupPlatforms: config.allowedWarmupPlatforms || [],
  })));
}

async function stopActiveTelegramBots(): Promise<void> {
  const current = activeTelegramBots;
  activeTelegramBots = [];
  for (const item of current) {
    try {
      await item.bot.stopPolling().catch(() => undefined);
      await stopTelegramPolling(item.config.token).catch(() => undefined);
    } catch {}
  }
}

async function applyTelegramBotRuntimeConfig(configs: TelegramBotRuntimeConfig[], reason: string): Promise<void> {
  const signature = telegramBotConfigSignature(configs);
  if (signature === activeTelegramBotSignature) return;

  if (!configs.length) {
    await stopActiveTelegramBots();
    activeTelegramBotSignature = signature;
    if (telegramBotLockClaimed) {
      releaseTelegramBotLock();
      telegramBotLockClaimed = false;
    }
    log("Telegram bot token is not configured; bot is not started");
    return;
  }

  if (!telegramBotLockClaimed) {
    if (!canStartTelegramBot()) {
      log("Another daemon instance owns the Telegram bot lock; skipping bot start");
      return;
    }
    claimTelegramBotLock();
    telegramBotLockClaimed = true;
  }

  await stopActiveTelegramBots();
  activeTelegramBotSignature = signature;
  for (const botConfig of configs) {
    await stopTelegramPolling(botConfig.token).catch(() => undefined);
    const bot = startTelegramBot(botConfig.token, {
      name: botConfig.name,
      defaultPublishPlatform: botConfig.defaultPublishPlatform,
      defaultWarmupPlatform: botConfig.defaultWarmupPlatform,
      allowedPublishPlatforms: botConfig.allowedPublishPlatforms,
      allowedWarmupPlatforms: botConfig.allowedWarmupPlatforms,
    });
    activeTelegramBots.push({ config: botConfig, bot });
    log(`Telegram bot started: ${botConfig.name || "unnamed"}${reason ? ` (${reason})` : ""}`);
  }
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`${ts} ${LOG_PREFIX} ${msg}`);
}

async function runRemovedLegacyPublishTask(): Promise<PublishTaskRunResult> {
  return {
    status: "failed",
    error: "Legacy mobile publish automation has been removed from this project",
    failureStep: "startup check",
    manualInterventionRequired: false,
  };
}

async function main() {
  writeDaemonHeartbeat({ state: "starting" });
  log("Workflow daemon starting...");
  const configPath = ensureRuntimeApiConfig();
  ensureRuntimeSecrets();
  log(`Runtime API config ready: ${configPath}`);

  const repo = createNodePublishQueueRepository();
  log("Publish queue database connected");
  const recovered = recoverInterruptedPublishQueue(repo);
  if (recovered.interrupted || recovered.expiredPaused || recovered.clearedLocks) {
    log(`Recovery: publishing=${recovered.interrupted} paused_expired=${recovered.expiredPaused} requeued=${recovered.requeued} post_publish_paused=${recovered.postPublishPaused} failed=${recovered.failed} locks_cleared=${recovered.clearedLocks}`);
  }

  const scheduler = new PublishSchedulerService(repo, runRemovedLegacyPublishTask, {
    onTaskStatusChange: (taskId, status, extra) => {
      const detail = extra?.error ? ` (${extra.error})` : "";
      log(`Task ${taskId} -> ${status}${detail}`);
    },
  });

  scheduler.start();
  log("Publish scheduler started with legacy mobile automation disabled");

  let botConfigTimer: NodeJS.Timeout | null = null;
  const reloadBotConfigs = async (reason: string) => {
    const configs = readLocalTelegramBotConfigs();
    await applyTelegramBotRuntimeConfig(configs, reason);
  };

  await reloadBotConfigs("startup");
  botConfigTimer = setInterval(() => {
    void reloadBotConfigs("config reload").catch((error) => {
      log(`Telegram bot config reload failed: ${error?.message || String(error)}`);
    });
  }, TELEGRAM_BOT_CONFIG_RELOAD_MS);

  const heartbeatTimer = setInterval(() => writeDaemonHeartbeat({ state: "running" }), 5000);
  writeDaemonHeartbeat({ state: "running" });

  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down`);
    scheduler.stop();
    if (botConfigTimer) clearInterval(botConfigTimer);
    clearInterval(heartbeatTimer);
    await stopActiveTelegramBots();
    releaseTelegramBotLock();
    removeDaemonHeartbeat();
    writeDaemonHeartbeat({ state: "stopped" });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log(`Fatal error: ${error?.message || String(error)}`);
  removeDaemonHeartbeat();
  writeDaemonHeartbeat({ state: "failed", error: error?.message || String(error) });
  process.exit(1);
});
