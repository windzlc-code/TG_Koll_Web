import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type WarmupMode = "browse" | "like" | "comment" | "both";
type WarmupPlatform = "threads";

type WarmupSelftestResult = {
  ok: boolean;
  platform: WarmupPlatform;
  mode: WarmupMode;
  browseCount: number;
  padCode: string;
  padName: string;
  elapsedMs: number;
  browsed: number;
  liked: number;
  commented: number;
  finalStep?: string;
  error?: string;
  progressLines: string[];
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasArg(name: string) {
  return process.argv.includes(`--${name}`);
}

function printHelp() {
  console.log([
    "Usage:",
    "  node --import tsx scripts/skills/telegram-warmup-button-selftest.ts --chatId=<telegram_chat_id> --pad=<pad_code> --mode=<browse|like|comment|both> --count=<n>",
    "",
    "Required:",
    "  --chatId or TELEGRAM_SELFTEST_CHAT_ID",
    "",
    "Example:",
    "  node --import tsx scripts/skills/telegram-warmup-button-selftest.ts --chatId=8100401093 --pad=ACP250322677KIRJ --mode=comment --count=6",
  ].join("\n"));
}

const WEBHOOK_URL = process.env.TELEGRAM_SELFTEST_WEBHOOK_URL
  || "http://127.0.0.1:8788/telegram/webhook/auto-script-webhook-secret";
const CHAT_ID_RAW = process.env.TELEGRAM_SELFTEST_CHAT_ID || argValue("chatId") || argValue("chat");
const CHAT_ID = Number(CHAT_ID_RAW || "NaN");
const FROM_ID = Number(process.env.TELEGRAM_SELFTEST_FROM_ID || argValue("fromId") || CHAT_ID);
const PAD_CODE = process.env.TELEGRAM_WARMUP_SELFTEST_PAD_CODE || argValue("pad") || argValue("padCode") || "ACP250430WZA6JZL";
const PAD_NAME = process.env.TELEGRAM_WARMUP_SELFTEST_PAD_NAME || argValue("padName") || "OP-TEST2";
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_SELFTEST_REQUEST_TIMEOUT_MS || 30_000);
const STEP_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_STEP_DELAY_MS || 900);
const WARMUP_TIMEOUT_MS = Number(process.env.TELEGRAM_WARMUP_SELFTEST_TIMEOUT_MS || 15 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.TELEGRAM_WARMUP_SELFTEST_POLL_INTERVAL_MS || 3_000);
const STALE_PROGRESS_TIMEOUT_MS = Number(process.env.TELEGRAM_WARMUP_SELFTEST_STALE_MS || 90_000);
const FAST_COUNT_MODE = process.env.TELEGRAM_WARMUP_SELFTEST_FAST_COUNT !== "0";
const LOG_PATH = path.resolve(
  process.env.TELEGRAM_WARMUP_SELFTEST_LOG_PATH || path.join(".runtime", "automatic-script", "warmup-progress.log"),
);

let updateId = Date.now();
let messageId = 970_000;
let callbackSeq = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs() {
  const platform = (process.env.TELEGRAM_WARMUP_SELFTEST_PLATFORM
    || argValue("platform")
    || "threads") as WarmupPlatform;
  if (!["threads"].includes(platform)) {
    throw new Error(`invalid warmup platform: ${platform}`);
  }
  const mode = (process.env.TELEGRAM_WARMUP_SELFTEST_MODE
    || argValue("mode")
    || "both") as WarmupMode;
  if (!["browse", "like", "comment", "both"].includes(mode)) {
    throw new Error(`invalid warmup mode: ${mode}`);
  }
  const browseCount = Number(
    process.env.TELEGRAM_WARMUP_SELFTEST_COUNT
    || argValue("count")
    || "5",
  );
  if (!Number.isFinite(browseCount) || browseCount <= 0) {
    throw new Error(`invalid browse count: ${browseCount}`);
  }
  return { platform, mode, browseCount: Math.floor(browseCount) };
}

function currentLogOffset() {
  return fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;
}

function readLogSince(offset: number) {
  if (!fs.existsSync(LOG_PATH)) return "";
  const fd = fs.openSync(LOG_PATH, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return "";
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

async function postWebhook(update: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: updateId++, ...update }),
      signal: controller.signal,
    });
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(`webhook ${response.status}: ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendCallback(data: string) {
  await postWebhook({
    callback_query: {
      id: `warmup-selftest-${Date.now()}-${callbackSeq++}`,
      from: {
        id: FROM_ID,
        is_bot: false,
        first_name: "CodexSelfTest",
      },
      message: {
        message_id: messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: CHAT_ID,
          type: "private",
          first_name: "CodexSelfTest",
        },
        text: "warmup selftest",
      },
      chat_instance: "warmup-selftest",
      data,
    },
  });
  await sleep(STEP_DELAY_MS);
}

function parseProgress(lines: string[]) {
  const allChatProgress = lines
    .filter((line) => line.includes("[telegram][warmup_progress]"))
    .filter((line) => line.includes(`chat=${CHAT_ID}`));
  const progress = allChatProgress
    .filter((line) => line.includes(`pad=${PAD_CODE}`));
  const latest = progress.at(-1);
  const otherPadLatest = allChatProgress
    .filter((line) => !line.includes(`pad=${PAD_CODE}`))
    .at(-1);
  if (!latest) return { progress, done: false, browsed: 0, liked: 0, commented: 0, otherPadLatest };
  const browsed = Number(latest.match(/\bbrowsed=(\d+)/)?.[1] || "0");
  const liked = Number(latest.match(/\bliked=(\d+)/)?.[1] || "0");
  const commented = Number(latest.match(/\bcommented=(\d+)/)?.[1] || "0");
  const done = /\bdone=1\b/.test(latest);
  const finalStep = latest.match(/\bstep=(.*)$/)?.[1];
  return { progress, done, browsed, liked, commented, finalStep, otherPadLatest };
}

async function waitForWarmupResult(
  platform: WarmupPlatform,
  mode: WarmupMode,
  browseCount: number,
  startedAt: number,
  logOffset: number,
): Promise<WarmupSelftestResult> {
  let lastProgressCount = 0;
  let lastProgressAt = startedAt;
  while (Date.now() - startedAt < WARMUP_TIMEOUT_MS) {
    const lines = readLogSince(logOffset).split(/\r?\n/).filter(Boolean);
    const parsed = parseProgress(lines);
    if (parsed.progress.length > lastProgressCount) {
      lastProgressCount = parsed.progress.length;
      lastProgressAt = Date.now();
      console.log(`[warmup-selftest][progress] ${parsed.progress.at(-1)}`);
    } else if (Date.now() - lastProgressAt > STALE_PROGRESS_TIMEOUT_MS) {
      return {
        ok: false,
        platform,
        mode,
        browseCount,
        padCode: PAD_CODE,
        padName: PAD_NAME,
        elapsedMs: Date.now() - startedAt,
        browsed: parsed.browsed,
        liked: parsed.liked,
        commented: parsed.commented,
        finalStep: parsed.finalStep,
        error: `stale warmup progress for ${Math.round(STALE_PROGRESS_TIMEOUT_MS / 1000)}s`,
        progressLines: parsed.progress,
      };
    }
    if (Date.now() - startedAt > 60_000 && parsed.progress.length === 0 && parsed.otherPadLatest) {
      return {
        ok: false,
        platform,
        mode,
        browseCount,
        padCode: PAD_CODE,
        padName: PAD_NAME,
        elapsedMs: Date.now() - startedAt,
        browsed: 0,
        liked: 0,
        commented: 0,
        error: `warmup selftest pad mismatch or stale config: expected pad=${PAD_CODE}, but latest progress was ${parsed.otherPadLatest}`,
        progressLines: [],
      };
    }
    if (parsed.done) {
      const interactionsOk = mode === "browse"
        || (mode === "like" ? parsed.liked > 0
          : mode === "comment" ? parsed.commented > 0
            : parsed.liked + parsed.commented > 0);
      const browseOk = parsed.browsed >= browseCount;
      const ok = browseOk && interactionsOk;
      return {
        ok,
        platform,
        mode,
        browseCount,
        padCode: PAD_CODE,
        padName: PAD_NAME,
        elapsedMs: Date.now() - startedAt,
        browsed: parsed.browsed,
        liked: parsed.liked,
        commented: parsed.commented,
        finalStep: parsed.finalStep,
        error: ok ? undefined : "warmup completed but required interactions were not observed",
        progressLines: parsed.progress,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const lines = readLogSince(logOffset).split(/\r?\n/).filter(Boolean);
  const parsed = parseProgress(lines);
  return {
    ok: false,
    platform,
    mode,
    browseCount,
    padCode: PAD_CODE,
    padName: PAD_NAME,
    elapsedMs: Date.now() - startedAt,
    browsed: parsed.browsed,
    liked: parsed.liked,
    commented: parsed.commented,
    finalStep: parsed.finalStep,
    error: `timeout waiting for warmup result after ${Math.round(WARMUP_TIMEOUT_MS / 1000)}s`,
    progressLines: parsed.progress,
  };
}

async function main() {
  if (hasArg("help") || hasArg("h")) {
    printHelp();
    return;
  }
  if (!Number.isFinite(CHAT_ID) || CHAT_ID <= 0) {
    throw new Error("TELEGRAM_SELFTEST_CHAT_ID or --chatId is required");
  }
  const { platform, mode, browseCount } = parseArgs();
  const logOffset = currentLogOffset();
  const startedAt = Date.now();

  console.log(`[warmup-selftest] platform=${platform} mode=${mode} count=${browseCount} pad=${PAD_NAME}/${PAD_CODE}`);
  if (FAST_COUNT_MODE) {
    await sendCallback(`warmup_count_${PAD_CODE}_${browseCount}`);
  } else {
    await sendCallback(`warmup_start_${platform}_${PAD_CODE}`);
  }
  await sendCallback(`warmup_engage_${platform}_${PAD_CODE}_${mode}`);
  await sendCallback(`warmup_run_${platform}_${PAD_CODE}`);

  const result = await waitForWarmupResult(platform, mode, browseCount, startedAt, logOffset);
  console.log(`[warmup-selftest] ${result.ok ? "ok" : "failed"} platform=${platform} elapsed=${Math.round(result.elapsedMs / 1000)}s browsed=${result.browsed} liked=${result.liked} commented=${result.commented}${result.error ? ` error=${result.error}` : ""}`);
  console.log(JSON.stringify({
    ...result,
    webhookUrl: WEBHOOK_URL,
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

const isCliEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCliEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: compactError(error) }, null, 2));
    process.exitCode = 1;
  });
}
