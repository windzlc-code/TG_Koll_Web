import "@/runtime/node/browser-shim";
import crypto from "node:crypto";
import {
  createPersonaArchive,
  deletePersonaArchive,
  loadPersonaArchive,
} from "@/lib/persona-archives";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";

installNodePersonaArchiveBridge();

const WEBHOOK_URL = process.env.TELEGRAM_SELFTEST_WEBHOOK_URL
  || "http://127.0.0.1:8788/telegram/webhook/auto-script-webhook-secret";
const CHAT_ID = Number(process.env.TELEGRAM_SELFTEST_CHAT_ID || "6470391105");
const FROM_ID = Number(process.env.TELEGRAM_SELFTEST_FROM_ID || CHAT_ID);
const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_SELFTEST_REQUEST_TIMEOUT_MS || 30_000);
const STEP_DELAY_MS = Number(process.env.TELEGRAM_SELFTEST_STEP_DELAY_MS || 900);
const KEEP_ARCHIVE = process.env.TELEGRAM_CUSTOM_POST_SELFTEST_KEEP_ARCHIVE === "1";

let updateId = Date.now();
let messageId = 980_000;
let callbackSeq = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      id: `custom-post-selftest-${Date.now()}-${callbackSeq++}`,
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
        text: "custom post selftest",
      },
      chat_instance: "custom-post-selftest",
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

async function waitForPost(archiveId: string, expectedContent: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const archive = await loadPersonaArchive(archiveId);
    const matched = archive?.posts.find((post) => post.content === expectedContent);
    if (archive && matched) return { archive, post: matched };
    await sleep(500);
  }
  throw new Error("custom post was not appended before timeout");
}

async function main() {
  const archiveId = `custom-post-selftest-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const content = `Codex 自定义入库自测 ${new Date().toISOString()}`;
  await createPersonaArchive({
    id: archiveId,
    name: "Codex自定义入库自测",
    content: "用于验证 Telegram 新建推文自定义入库的临时人设。",
    setup: {
      personaName: "Codex自定义入库自测",
      personaPersonality: "测试",
      personaStyle: "链路验证",
      genres: ["自动化测试"],
      targetMarket: "tw",
      chineseScript: "traditional",
    } as any,
  });

  try {
    await sendCallback(`genpost_custom_${archiveId}`);
    await sendText(content);
    const { archive, post } = await waitForPost(archiveId, content);
    process.stdout.write(JSON.stringify({
      ok: true,
      archiveId,
      postId: post.id,
      posts: archive.posts.length,
      content: post.content,
      hasMedia: Boolean(post.imageUrl),
    }, null, 2));
  } finally {
    if (!KEEP_ARCHIVE) {
      await deletePersonaArchive(archiveId).catch(() => null);
    }
  }
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
