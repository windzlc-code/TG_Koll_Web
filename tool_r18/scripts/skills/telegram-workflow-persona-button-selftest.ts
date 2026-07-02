import "@/runtime/node/browser-shim";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TelegramBot from "node-telegram-bot-api";
import { listPersonaArchives, loadPersonaArchive } from "@/lib/persona-archives";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";

installNodePersonaArchiveBridge();

type PersonaTarget = {
  id: string;
  name: string;
  initialPosts: number;
  initialImages: number;
};

type PersonaResult = {
  id: string;
  name: string;
  ok: boolean;
  beforePosts: number;
  afterPosts: number;
  beforeImages: number;
  afterImages: number;
  imageUrl?: string;
  error?: string;
};

const WEBHOOK_URL = process.env.TELEGRAM_SELFTEST_WEBHOOK_URL
  || "http://127.0.0.1:8788/telegram/webhook/auto-script-webhook-secret";
const CHAT_ID = Number(process.env.TELEGRAM_SELFTEST_CHAT_ID || "6470391105");
const FROM_ID = Number(process.env.TELEGRAM_SELFTEST_FROM_ID || CHAT_ID);
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_SELFTEST_REQUEST_TIMEOUT_MS || 30_000);
const STEP_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_STEP_DELAY_MS || 1_000);
const MODE_TO_COUNT_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_MODE_TO_COUNT_DELAY_MS || STEP_DELAY_MS);
const PROMPT_TO_WORD_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_PROMPT_TO_WORD_DELAY_MS || STEP_DELAY_MS);
const PERSONA_TIMEOUT_MS = Number(process.env.TELEGRAM_SELFTEST_PERSONA_TIMEOUT_MS || 12 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.TELEGRAM_SELFTEST_POLL_INTERVAL_MS || 15_000);
const TARGET_WORDS = Number(process.env.TELEGRAM_SELFTEST_TARGET_WORDS || 50);
const COUNT = Number(process.env.TELEGRAM_SELFTEST_COUNT || 1);
const CUSTOM_PROMPT = String(process.env.TELEGRAM_SELFTEST_PROMPT || "").trim();
const TARGET_IDS = new Set(
  String(process.env.TELEGRAM_SELFTEST_TARGET_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

let updateId = Date.now();
let messageId = 900_000;
let callbackSeq = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compactImageUrl(imageUrl: string | undefined) {
  if (!imageUrl) return "";
  return imageUrl.length > 140 ? `${imageUrl.slice(0, 140)}...` : imageUrl;
}

function readTelegramToken(): string {
  const tokenFile = resolveRuntimeFile("telegram_bot_token.txt");
  const token = process.env.TELEGRAM_BOT_TOKEN
    || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");
  return token.trim();
}

async function createRealAnchorMessage() {
  if (process.env.TELEGRAM_SELFTEST_REAL_ANCHOR === "0") return;
  const token = readTelegramToken();
  if (!token) return;
  const bot = new TelegramBot(token, { polling: false });
  const sent = await bot.sendMessage(
    CHAT_ID,
    "Codex 自测：模拟真人点击，为每个工作流人设生成 1 篇带图推文。",
  );
  messageId = sent.message_id;
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
      id: `workflow-selftest-${Date.now()}-${callbackSeq++}`,
      from: {
        id: FROM_ID,
        is_bot: false,
        first_name: "CodexSelfTest",
      },
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: CHAT_ID,
          type: "private",
          first_name: "CodexSelfTest",
        },
        text: "workflow persona selftest",
      },
      chat_instance: "workflow-persona-selftest",
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
      chat: {
        id: CHAT_ID,
        type: "private",
        first_name: "CodexSelfTest",
      },
      from: {
        id: FROM_ID,
        is_bot: false,
        first_name: "CodexSelfTest",
      },
      text,
    },
  });
  await sleep(STEP_DELAY_MS);
}

function countImages(posts: Array<{ imageUrl?: string }>) {
  return posts.filter((post) => Boolean(post.imageUrl)).length;
}

async function getPersonaTargets(): Promise<PersonaTarget[]> {
  const list = await listPersonaArchives();
  return list
    .filter((archive) => archive.id.startsWith("workflow-persona-"))
    .filter((archive) => TARGET_IDS.size === 0 || TARGET_IDS.has(archive.id))
    .map((archive) => ({
      id: archive.id,
      name: archive.name,
      initialPosts: archive.posts?.length || 0,
      initialImages: countImages(archive.posts || []),
    }));
}

async function waitForPersonaResult(target: PersonaTarget): Promise<PersonaResult> {
  const startedAt = Date.now();
  let lastPostCount = target.initialPosts;
  let lastImageCount = target.initialImages;

  while (Date.now() - startedAt < PERSONA_TIMEOUT_MS) {
    const archive = await loadPersonaArchive(target.id).catch(() => null);
    const posts = archive?.posts || [];
    lastPostCount = posts.length;
    lastImageCount = countImages(posts);

    const newPosts = posts.slice(target.initialPosts);
    const newImagePost = newPosts.find((post) => Boolean(post.imageUrl));
    if (newImagePost?.imageUrl) {
      return {
        id: target.id,
        name: target.name,
        ok: true,
        beforePosts: target.initialPosts,
        afterPosts: lastPostCount,
        beforeImages: target.initialImages,
        afterImages: lastImageCount,
        imageUrl: newImagePost.imageUrl,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return {
    id: target.id,
    name: target.name,
    ok: false,
    beforePosts: target.initialPosts,
    afterPosts: lastPostCount,
    beforeImages: target.initialImages,
    afterImages: lastImageCount,
    error: `timeout waiting for generated post image after ${Math.round(PERSONA_TIMEOUT_MS / 1000)}s`,
  };
}

async function runPersona(target: PersonaTarget): Promise<PersonaResult> {
  console.log(`[selftest] ${target.name} (${target.id}) start: posts=${target.initialPosts} images=${target.initialImages}`);

  await sendCallback(`genpost_${target.id}`);
  await sendCallback(`genpost_mode_${target.id}_withimage`);
  await sendCallback("genmem_skip");
  if (MODE_TO_COUNT_DELAY_MS > STEP_DELAY_MS) {
    await sleep(MODE_TO_COUNT_DELAY_MS - STEP_DELAY_MS);
  }
  await sendText(String(COUNT));
  if (CUSTOM_PROMPT) {
    await sendText(CUSTOM_PROMPT);
    if (PROMPT_TO_WORD_DELAY_MS > STEP_DELAY_MS) {
      await sleep(PROMPT_TO_WORD_DELAY_MS - STEP_DELAY_MS);
    }
  } else {
    await sendCallback("genpost_prompt_skip");
  }
  await sendText(String(TARGET_WORDS));

  const result = await waitForPersonaResult(target);
  console.log(`[selftest] ${target.name} ${result.ok ? "ok" : "failed"}: posts ${result.beforePosts}->${result.afterPosts}, images ${result.beforeImages}->${result.afterImages}${result.imageUrl ? `, image=${compactImageUrl(result.imageUrl)}` : ""}${result.error ? `, error=${result.error}` : ""}`);
  return result;
}

async function main() {
  if (!Number.isFinite(CHAT_ID) || CHAT_ID <= 0) {
    throw new Error("TELEGRAM_SELFTEST_CHAT_ID is required");
  }

  await createRealAnchorMessage();

  const targets = await getPersonaTargets();
  if (TARGET_IDS.size === 0 && targets.length !== 8) {
    throw new Error(`expected 8 workflow personas, got ${targets.length}: ${targets.map((item) => item.name).join(", ")}`);
  }
  if (TARGET_IDS.size > 0 && targets.length !== TARGET_IDS.size) {
    throw new Error(`expected ${TARGET_IDS.size} selected workflow personas, got ${targets.length}: ${targets.map((item) => item.name).join(", ")}`);
  }

  const results: PersonaResult[] = [];
  for (const target of targets) {
    results.push(await runPersona(target));
  }

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({
    ok,
    chatId: CHAT_ID,
    webhookUrl: WEBHOOK_URL,
    count: COUNT,
    targetWords: TARGET_WORDS,
    customPrompt: CUSTOM_PROMPT || undefined,
    results: results.map((result) => ({
      ...result,
      imageUrl: compactImageUrl(result.imageUrl),
    })),
  }, null, 2));
  if (!ok) process.exitCode = 1;
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
