import "@/runtime/node/browser-shim";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  createPersonaArchive,
  deletePersonaArchive,
  loadPersonaArchive,
  savePersonaArchive,
} from "@/lib/persona-archives";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";

installNodePersonaArchiveBridge();

type PublishMode = "text" | "image" | "video";

type PublishSelftestResult = {
  mode: PublishMode;
  archiveId: string;
  postId: string;
  ok: boolean;
  beforePosts: number;
  afterPosts: number;
  beforeHistory: number;
  afterHistory: number;
  elapsedMs: number;
  error?: string;
};

const WEBHOOK_URL = process.env.TELEGRAM_SELFTEST_WEBHOOK_URL
  || "http://127.0.0.1:8788/telegram/webhook/auto-script-webhook-secret";
const CHAT_ID = Number(process.env.TELEGRAM_SELFTEST_CHAT_ID || "6470391105");
const FROM_ID = Number(process.env.TELEGRAM_SELFTEST_FROM_ID || CHAT_ID);
const PAD_CODE = process.env.TELEGRAM_PUBLISH_SELFTEST_PAD_CODE || "ACP250430WZA6JZL";
const PAD_NAME = process.env.TELEGRAM_PUBLISH_SELFTEST_PAD_NAME || "OP-TEST2";
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_SELFTEST_REQUEST_TIMEOUT_MS || 30_000);
const STEP_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_STEP_DELAY_MS || 900);
const PUBLISH_TIMEOUT_MS = Number(process.env.TELEGRAM_PUBLISH_SELFTEST_TIMEOUT_MS || 18 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.TELEGRAM_PUBLISH_SELFTEST_POLL_INTERVAL_MS || 10_000);
const ARCHIVE_GRACE_AFTER_DONE_MS = Number(process.env.TELEGRAM_PUBLISH_SELFTEST_ARCHIVE_GRACE_MS || 120_000);
const CLEANUP_ARCHIVES = process.env.TELEGRAM_PUBLISH_SELFTEST_KEEP_ARCHIVES !== "1";
const VIDEO_PATH = process.env.TELEGRAM_PUBLISH_SELFTEST_VIDEO_PATH
  || path.resolve("output", "ig5", "ig5.mp4");
const PUBLISH_SAMPLE_ROOT = path.resolve(".runtime", "automatic-script", "publish-samples", "threads");
const PUBLISH_LOG_PATH = path.resolve(
  process.env.TELEGRAM_PUBLISH_SELFTEST_LOG_PATH || path.join(".runtime", "automatic-script", "publish-progress.log"),
);

let updateId = Date.now();
let messageId = 950_000;
let callbackSeq = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseModes(): PublishMode[] {
  const raw = process.env.TELEGRAM_PUBLISH_SELFTEST_MODES
    || process.argv.find((arg) => arg.startsWith("--modes="))?.slice("--modes=".length)
    || "text,image,video";
  const modes = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = new Set<PublishMode>(["text", "image", "video"]);
  const invalid = modes.filter((item) => !allowed.has(item as PublishMode));
  if (invalid.length > 0) {
    throw new Error(`invalid modes: ${invalid.join(", ")}`);
  }
  return modes as PublishMode[];
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function listJsonFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsonFilesRecursive(fullPath);
    return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
  });
}

function findLatestPublishSampleSince(sinceMs: number) {
  return listJsonFilesRecursive(PUBLISH_SAMPLE_ROOT)
    .filter((filePath) => path.basename(filePath) !== "sample-index.json")
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .filter((item) => item.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath;
}

function currentLogOffset() {
  return fs.existsSync(PUBLISH_LOG_PATH) ? fs.statSync(PUBLISH_LOG_PATH).size : 0;
}

function readLogSince(offset: number) {
  if (!fs.existsSync(PUBLISH_LOG_PATH)) return "";
  const fd = fs.openSync(PUBLISH_LOG_PATH, "r");
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

function parseLatestPublishProgress(logOffset: number, archiveId: string, postId: string) {
  const lines = readLogSince(logOffset).split(/\r?\n/).filter(Boolean);
  const progress = lines
    .filter((line) => line.includes("[telegram][publish_progress]"))
    .filter((line) => line.includes(`archive=${archiveId}`))
    .filter((line) => line.includes(`post=${postId}`));
  const latest = progress.at(-1);
  if (!latest) return { progress, latest: undefined, done: false, warning: false, step: undefined as string | undefined };
  const step = latest.match(/\bstep=(.*)$/)?.[1];
  return {
    progress,
    latest,
    done: /\bdone=1\b/.test(latest),
    warning: /\bwarning=1\b/.test(latest),
    error: /\berror=1\b/.test(latest) || /發布失敗|发布失败/.test(step || latest),
    step,
  };
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
      id: `publish-selftest-${Date.now()}-${callbackSeq++}`,
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
        text: "publish matrix selftest",
      },
      chat_instance: "publish-matrix-selftest",
      data,
    },
  });
  await sleep(STEP_DELAY_MS);
}

async function buildImageDataUrl(label: string) {
  const svg = `
    <svg width="960" height="960" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f97316"/>
          <stop offset="1" stop-color="#2563eb"/>
        </linearGradient>
      </defs>
      <rect width="960" height="960" fill="url(#g)"/>
      <circle cx="720" cy="220" r="120" fill="rgba(255,255,255,0.25)"/>
      <rect x="120" y="570" width="720" height="150" rx="30" fill="rgba(0,0,0,0.35)"/>
      <text x="480" y="430" text-anchor="middle" font-family="Arial" font-size="64" font-weight="700" fill="#fff">Threads Publish Test</text>
      <text x="480" y="665" text-anchor="middle" font-family="Arial" font-size="42" fill="#fff">${label}</text>
    </svg>
  `;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function buildVideoDataUrl() {
  if (!fs.existsSync(VIDEO_PATH)) {
    throw new Error(`video fixture not found: ${VIDEO_PATH}`);
  }
  return `data:video/mp4;base64,${fs.readFileSync(VIDEO_PATH).toString("base64")}`;
}

async function createPublishArchive(mode: PublishMode) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archiveId = `cpm-${mode}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const postId = `post-${mode}-${crypto.randomUUID()}`;
  const mediaUrl = mode === "image"
    ? await buildImageDataUrl(stamp)
    : mode === "video"
      ? buildVideoDataUrl()
      : undefined;
  const archive = await createPersonaArchive({
    id: archiveId,
    name: `Codex发布矩阵测试-${mode}`,
    content: "这是 Codex 用于验证 Telegram 按键发布链路的临时测试人设。",
    setup: {
      personaName: `Codex发布矩阵测试-${mode}`,
      personaPersonality: "测试账号",
      personaStyle: "链路验证",
      personaGender: "neutral",
      genres: ["自动化测试"],
      targetMarket: "tw",
      chineseScript: "traditional",
    } as any,
  });
  const content = [
    `Codex 自动化链路测试 ${mode.toUpperCase()}`,
    `时间：${now.toISOString()}`,
    "这是一条用于验证 Telegram 按键发布到 Threads 的测试内容。",
  ].join("\n");
  const saved = await savePersonaArchive({
    ...archive,
    boundPadCode: PAD_CODE,
    boundPadName: PAD_NAME,
    posts: [{
      id: postId,
      title: `发布矩阵 ${mode}`,
      content,
      wordCount: content.length,
      orderIndex: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      imageUrl: mediaUrl,
    }],
  });
  return { archiveId: saved.id, postId };
}

async function waitForPublishResult(
  mode: PublishMode,
  archiveId: string,
  postId: string,
  startedAt: number,
  logOffset: number,
): Promise<PublishSelftestResult> {
  const initial = await loadPersonaArchive(archiveId);
  const beforePosts = initial?.posts.length || 0;
  const beforeHistory = initial?.publishHistory?.length || 0;
  let lastPosts = beforePosts;
  let lastHistory = beforeHistory;
  let publishDoneAt = 0;
  let publishWarningAt = 0;

  while (Date.now() - startedAt < PUBLISH_TIMEOUT_MS) {
    const archive = await loadPersonaArchive(archiveId).catch(() => null);
    lastPosts = archive?.posts.length || 0;
    lastHistory = archive?.publishHistory?.length || 0;
    const published = archive?.publishHistory?.some((item) => item.archivePostId === postId && item.platform === "threads");
    const stillPending = archive?.posts.some((post) => post.id === postId);
    if (published && !stillPending) {
      return {
        mode,
        archiveId,
        postId,
        ok: true,
        beforePosts,
        afterPosts: lastPosts,
        beforeHistory,
        afterHistory: lastHistory,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const parsedProgress = parseLatestPublishProgress(logOffset, archiveId, postId);
    if (parsedProgress.done && parsedProgress.error) {
      return {
        mode,
        archiveId,
        postId,
        ok: false,
        beforePosts,
        afterPosts: lastPosts,
        beforeHistory,
        afterHistory: lastHistory,
        elapsedMs: Date.now() - startedAt,
        error: `publish failed: ${parsedProgress.step || parsedProgress.latest}`,
      };
    }
    if (parsedProgress.done && !parsedProgress.warning) {
      publishDoneAt ||= Date.now();
      if (Date.now() - publishDoneAt >= ARCHIVE_GRACE_AFTER_DONE_MS) {
        return {
          mode,
          archiveId,
          postId,
          ok: true,
          beforePosts,
          afterPosts: lastPosts,
          beforeHistory,
          afterHistory: lastHistory,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    if (parsedProgress.done && parsedProgress.warning) {
      publishWarningAt ||= Date.now();
      if (Date.now() - publishWarningAt < ARCHIVE_GRACE_AFTER_DONE_MS) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      return {
        mode,
        archiveId,
        postId,
        ok: false,
        beforePosts,
        afterPosts: lastPosts,
        beforeHistory,
        afterHistory: lastHistory,
        elapsedMs: Date.now() - startedAt,
        error: `publish finished with warning: ${parsedProgress.step || parsedProgress.latest}`,
      };
    }
    const samplePath = findLatestPublishSampleSince(startedAt);
    if (samplePath && !(mode === "video" && publishWarningAt && Date.now() - publishWarningAt < ARCHIVE_GRACE_AFTER_DONE_MS)) {
      return {
        mode,
        archiveId,
        postId,
        ok: false,
        beforePosts,
        afterPosts: lastPosts,
        beforeHistory,
        afterHistory: lastHistory,
        elapsedMs: Date.now() - startedAt,
        error: `publish sample captured: ${samplePath}`,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    mode,
    archiveId,
    postId,
    ok: false,
    beforePosts,
    afterPosts: lastPosts,
    beforeHistory,
    afterHistory: lastHistory,
    elapsedMs: Date.now() - startedAt,
    error: `timeout waiting for publish result after ${Math.round(PUBLISH_TIMEOUT_MS / 1000)}s`,
  };
}

async function runMode(mode: PublishMode): Promise<PublishSelftestResult> {
  const { archiveId, postId } = await createPublishArchive(mode);
  const startedAt = Date.now();
  const logOffset = currentLogOffset();
  console.log(`[publish-selftest] ${mode} archive=${archiveId} post=${postId} pad=${PAD_NAME}/${PAD_CODE}`);
  try {
    await sendCallback(`pub_${archiveId}`);
    await sendCallback("sp");
    await sendCallback("mp_threads");
    await sendCallback("mc_1");
    await sendCallback("mconfirm");
    const result = await waitForPublishResult(mode, archiveId, postId, startedAt, logOffset);
    console.log(`[publish-selftest] ${mode} ${result.ok ? "ok" : "failed"} elapsed=${Math.round(result.elapsedMs / 1000)}s posts=${result.beforePosts}->${result.afterPosts} history=${result.beforeHistory}->${result.afterHistory}${result.error ? ` error=${result.error}` : ""}`);
    return result;
  } catch (error) {
    return {
      mode,
      archiveId,
      postId,
      ok: false,
      beforePosts: 1,
      afterPosts: 1,
      beforeHistory: 0,
      afterHistory: 0,
      elapsedMs: Date.now() - startedAt,
      error: compactError(error),
    };
  } finally {
    if (CLEANUP_ARCHIVES) {
      await deletePersonaArchive(archiveId).catch(() => undefined);
    }
  }
}

async function main() {
  if (!Number.isFinite(CHAT_ID) || CHAT_ID <= 0) {
    throw new Error("TELEGRAM_SELFTEST_CHAT_ID is required");
  }

  const modes = parseModes();
  const results: PublishSelftestResult[] = [];
  for (const mode of modes) {
    results.push(await runMode(mode));
  }

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({
    ok,
    modes,
    chatId: CHAT_ID,
    webhookUrl: WEBHOOK_URL,
    padCode: PAD_CODE,
    padName: PAD_NAME,
    cleanupArchives: CLEANUP_ARCHIVES,
    results,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

const isCliEntrypoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCliEntrypoint) {
  main()
    .then(() => {
      process.exit(process.exitCode || 0);
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: compactError(error) }, null, 2));
      process.exit(1);
    });
}
