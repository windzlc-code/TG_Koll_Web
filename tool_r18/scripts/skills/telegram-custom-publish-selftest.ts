import "../../src/runtime/node/browser-shim";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import TelegramBot from "node-telegram-bot-api";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(process.cwd());
const RUNTIME_DIR = path.join(PROJECT_ROOT, ".runtime", "automatic-script");
const WEBHOOK_URL = process.env.TELEGRAM_SELFTEST_WEBHOOK_URL
  || "http://127.0.0.1:8788/telegram/webhook/auto-script-webhook-secret";
const CHAT_ID = Number(process.env.TELEGRAM_SELFTEST_CHAT_ID || "6470391105");
const FROM_ID = Number(process.env.TELEGRAM_SELFTEST_FROM_ID || CHAT_ID);
const PAD_CODE = process.env.TELEGRAM_CUSTOM_PUBLISH_PAD_CODE || "ACP250322677KIRJ";
const ARCHIVE_ID = process.env.TELEGRAM_CUSTOM_PUBLISH_ARCHIVE_ID || "persona-selftest";
const PLATFORM = (process.env.TELEGRAM_CUSTOM_PUBLISH_PLATFORM
  || process.argv.find((arg) => arg.startsWith("--platform="))?.split("=")[1]
  || "threads") as "threads" | "telegram";
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_SELFTEST_REQUEST_TIMEOUT_MS || 900_000);
const STEP_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_STEP_DELAY_MS || 1200);

let updateId = Date.now();
let messageId = 1_180_000;
let callbackSeq = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTelegramToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN
    || (fs.existsSync(path.join(RUNTIME_DIR, "telegram_bot_token.txt"))
      ? fs.readFileSync(path.join(RUNTIME_DIR, "telegram_bot_token.txt"), "utf8").trim()
      : "");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  return token;
}

function buildTelegramRequestOptions(): Record<string, unknown> {
  const proxyUrl = String(process.env.TELEGRAM_PROXY_URL || (process.platform === "win32" ? "http://127.0.0.1:9974" : "")).trim();
  if (!proxyUrl) return { timeout: 120_000 };
  return {
    proxy: proxyUrl,
    tunnel: true,
    forever: true,
    timeout: 120_000,
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
    if (!response.ok) throw new Error(`webhook ${response.status}: ${body.slice(0, 300)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function sendCallback(data: string) {
  await postWebhook({
    callback_query: {
      id: `custom-publish-selftest-${Date.now()}-${callbackSeq++}`,
      from: { id: FROM_ID, is_bot: false, first_name: "CodexSelfTest" },
      message: {
        message_id: messageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private", first_name: "CodexSelfTest" },
        text: "custom publish selftest",
      },
      chat_instance: "custom-publish-selftest",
      data,
    },
  });
  await sleep(STEP_DELAY_MS);
}

async function sendText(text: string) {
  await postWebhook({
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private", first_name: "CodexSelfTest" },
      from: { id: FROM_ID, is_bot: false, first_name: "CodexSelfTest" },
      text,
    },
  });
  await sleep(STEP_DELAY_MS);
}

async function sendPhotoUpdate(fileId: string, caption: string) {
  await postWebhook({
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private", first_name: "CodexSelfTest" },
      from: { id: FROM_ID, is_bot: false, first_name: "CodexSelfTest" },
      caption,
      photo: [
        { file_id: fileId, file_unique_id: `selftest-photo-${Date.now()}`, width: 128, height: 128, file_size: 1024 },
      ],
    },
  });
  await sleep(STEP_DELAY_MS);
}

async function sendVideoUpdate(fileId: string, caption: string) {
  await postWebhook({
    message: {
      message_id: messageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: "private", first_name: "CodexSelfTest" },
      from: { id: FROM_ID, is_bot: false, first_name: "CodexSelfTest" },
      caption,
      video: {
        file_id: fileId,
        file_unique_id: `selftest-video-${Date.now()}`,
        width: 320,
        height: 320,
        duration: 2,
        mime_type: "video/mp4",
        file_size: 4096,
      },
    },
  });
  await sleep(STEP_DELAY_MS);
}

async function chooseDirectPublishEntry(archiveId: string) {
  await sendCallback(`custom_publish_persona_${archiveId}`);
  await sendCallback(`custom_publish_platform_${PLATFORM}`);
  await sendCallback("custom_publish_confirm_pad");
}

async function createImageFile(filePath: string) {
  const sharp = (await import("sharp")).default;
  await sharp({
    create: {
      width: 720,
      height: 720,
      channels: 3,
      background: { r: 38, g: 94, b: 128 },
    },
  })
    .composite([{
      input: Buffer.from(`<svg width="720" height="720"><rect width="720" height="720" fill="#265e80"/><text x="64" y="370" font-size="48" fill="white">Custom image selftest</text></svg>`),
      left: 0,
      top: 0,
    }])
    .png()
    .toFile(filePath);
}

async function createVideoFile(filePath: string) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=0x283044:s=320x320:d=2",
    "-vf", "format=yuv420p",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    filePath,
  ], { timeout: 60_000 });
}

async function uploadTelegramPhoto(bot: TelegramBot, filePath: string): Promise<string> {
  const sent = await bot.sendPhoto(CHAT_ID, filePath, { caption: "custom publish image selftest seed" });
  const fileId = sent.photo?.[sent.photo.length - 1]?.file_id;
  if (!fileId) throw new Error("photo upload did not return file_id");
  return fileId;
}

async function uploadTelegramVideo(bot: TelegramBot, filePath: string): Promise<string> {
  const sent = await bot.sendVideo(CHAT_ID, filePath, { caption: "custom publish video selftest seed" });
  const fileId = sent.video?.file_id;
  if (!fileId) throw new Error("video upload did not return file_id");
  return fileId;
}

async function main() {
  const mode = (process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] || "all") as "text" | "image" | "video" | "all";
  const archiveId = ARCHIVE_ID;
  const token = readTelegramToken();
  const bot = new TelegramBot(token, { polling: false, request: buildTelegramRequestOptions() as any });
  const tmpDir = path.join(RUNTIME_DIR, "custom-publish-selftest");
  fs.mkdirSync(tmpDir, { recursive: true });
  const results: Array<{ mode: string; ok: boolean; caption: string }> = [];

  if (mode === "text" || mode === "all") {
    const caption = `custom text selftest ${new Date().toISOString()}`;
    await chooseDirectPublishEntry(archiveId);
    await sendText(caption);
    await sendCallback("custom_publish_publish_now");
    results.push({ mode: "text", ok: true, caption });
  }

  if (mode === "image" || mode === "all") {
    const imagePath = path.join(tmpDir, `custom-image-${Date.now()}.png`);
    await createImageFile(imagePath);
    const fileId = await uploadTelegramPhoto(bot, imagePath);
    const caption = `custom image selftest ${new Date().toISOString()}`;
    await chooseDirectPublishEntry(archiveId);
    await sendPhotoUpdate(fileId, caption);
    results.push({ mode: "image", ok: true, caption });
  }

  if (mode === "video" || mode === "all") {
    const videoPath = path.join(tmpDir, `custom-video-${Date.now()}.mp4`);
    await createVideoFile(videoPath);
    const fileId = await uploadTelegramVideo(bot, videoPath);
    const caption = `custom video selftest ${new Date().toISOString()}`;
    await chooseDirectPublishEntry(archiveId);
    await sendVideoUpdate(fileId, caption);
    results.push({ mode: "video", ok: true, caption });
  }

  process.stdout.write(JSON.stringify({ ok: true, archiveId, padCode: PAD_CODE, platform: PLATFORM, results }, null, 2));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
