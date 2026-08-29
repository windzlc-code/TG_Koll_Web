import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { ProxyAgent } from "undici";
import type { PersonaArchive } from "@/core/archives/persona-archive-domain";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { withExclusiveJsonFileLock } from "@/runtime/node/json-file-lock";
import { withSentimentHotExecutionLock } from "@/lib/sentiment-hot-execution-lock";
import {
  AdaptiveHotRateLimiter,
} from "@/lib/adaptive-hot-rate-limiter";
import {
  createReaderResponseCoordinator,
  type ReaderResponseCacheMode,
  type ReaderResponseSnapshot,
} from "@/lib/reader-response-coordinator";
import { readRuntimeApiConfig } from "@/runtime/node/config";
import { callTextUnderstandingModelWithFallback, extractText, getTextUnderstandingModelFallbacks, isTextModelFallbackError } from "@/lib/gemini-client";
import {
  buildSentimentCandidateId,
  getSentimentHotCandidateHistoryKeys,
  getSentimentHotExcludedIds,
  getSentimentHotRefreshExcludedIds,
  getSentimentHotShownHistoryKeys,
  getSentimentHotShownHistoryAtMap,
  getSentimentHotShownAtMap,
  getSentimentHotShownIds,
  rememberSentimentHotShown,
  forgetSentimentHotShown,
  type SentimentHotCandidate,
  type SentimentHotMedia,
  type SentimentHotPlatform,
} from "@/lib/sentiment-candidate-store";
import {
  ensureSentimentRuntime,
  resolveSentimentBackendUrl,
  resolveSentimentConfigPath,
  resolveSentimentDataDir,
} from "@/lib/sentiment-runtime-manager";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
// One explicit heat floor keeps selection predictable: reject everything below
// 500, then rank every qualified candidate by real engagement from high to low.
const MIN_SENTIMENT_HOT_SCORE = 500;
const MIN_SENTIMENT_HOT_SCORE_FLOOR = MIN_SENTIMENT_HOT_SCORE;
const SENTIMENT_HOT_SCORE_FALLBACK_STEPS = [
  MIN_SENTIMENT_HOT_SCORE,
] as const;
// High-heat results remain preferred. For a sparse niche, the browser may add
// recent, topic-anchored posts with verified engagement fields behind them.
const MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT = 20;
const MIN_PUBLIC_THREADS_HOT_HAN_COUNT = 20;
const MIN_SENTIMENT_HOT_READABLE_CHARACTER_COUNT = 20;
const SENTIMENT_HOT_CANDIDATE_POOL_TARGET = 2_000;
const THREADS_SEARCH_CACHE_CANDIDATE_LIMIT = 2000;
const THREADS_SEARCH_CACHE_MAX_ROWS_PER_ARCHIVE = 40;
const THREADS_BROWSER_QUERY_LIMIT = 8;
// Keep the total number of in-flight GraphQL requests bounded. Two pages retain
// parallel coverage without letting one server-side browser lease fan out into
// an unbounded number of renderer processes.
const THREADS_BROWSER_QUERY_BATCH_SIZE = 3;
const THREADS_BROWSER_PAGE_LIMIT = 2;
const THREADS_BROWSER_BOOTSTRAP_QUERY_LIMIT = 3;
// The anonymous public browser is only a fast fallback for Spider. When
// Threads exposes no search payload, keeping Chromium alive for the full
// source-stage budget delays the usable public Spider path without producing
// candidates.  Bound that probe so the complete interactive search remains
// within the UI budget.
const THREADS_PUBLIC_BROWSER_TIMEOUT_MS = 22_000;
const THREADS_PUBLIC_RESULTS_WAIT_MS = 5_500;
// Threads can render the search page first and emit its GraphQL request a few
// seconds later. Keep the capture listener alive long enough to observe that
// request before falling back to DOM-only parsing.
const THREADS_BROWSER_TEMPLATE_WAIT_ATTEMPTS = 12;
const THREADS_BROWSER_REQUEST_TIMEOUT_MS = 5_000;
const THREADS_BROWSER_DETAIL_RESCUE_LIMIT = 30;
const THREADS_BROWSER_DETAIL_RESCUE_POOL_LIMIT = 120;
const THREADS_BROWSER_DETAIL_RESCUE_BATCH_SIZE = 6;
const THREADS_BROWSER_DETAIL_RESCUE_MIN_REMAINING_MS = 5_000;
const THREADS_BROWSER_EARLY_DETAIL_RESCUE_MIN_REMAINING_MS = 8_000;
const THREADS_MANUAL_SEARCH_TRIGGER_WAIT_MS = 1_200;
const SENTIMENT_MODEL_KEYWORD_TARGET = 24;
const SENTIMENT_HOT_KEYWORD_MODEL = "xai/grok-4.5, xai/grok-4.3, google/gemini-3.1-pro-preview";
export function resolveSentimentHotReaderConcurrency(value: unknown = process.env.SENTIMENT_HOT_READER_CONCURRENCY): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 24)) : 24;
}
export function shouldRunSentimentHotReaderPlatformsSerially(
  value: unknown = process.env.SENTIMENT_HOT_READER_SERIAL_PLATFORMS,
): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}
// Interactive requests keep the fixed public Reader window. The worker injects
// four processes plus serial platform execution only for scheduled refills.
export const SENTIMENT_HOT_READER_CONCURRENCY = resolveSentimentHotReaderConcurrency();
const SENTIMENT_HOT_READER_SERIAL_PLATFORMS = shouldRunSentimentHotReaderPlatformsSerially();
const THREADS_READER_TOTAL_QUERY_LIMIT = SENTIMENT_HOT_READER_CONCURRENCY;
const THREADS_READER_QUERY_BATCH_SIZE = SENTIMENT_HOT_READER_CONCURRENCY;
// Instagram public tag pages are complementary. Interactive collection starts
// them beside Threads; conservative refill starts them only after Threads.
const INSTAGRAM_READER_QUERY_LIMIT = SENTIMENT_HOT_READER_CONCURRENCY;
const INSTAGRAM_READER_STAGE_TIMEOUT_MS = 36_000;
const INSTAGRAM_AUTHENTICATED_QUERY_LIMIT = 16;
const INSTAGRAM_GRAPHQL_PAGE_QUERY_LIMIT = 10;
const INSTAGRAM_KEYWORD_SEARCH_PAGE_QUERY_LIMIT = 10;
const INSTAGRAM_AUTHENTICATED_QUERY_BATCH_SIZE = 2;
const INSTAGRAM_DIRECT_TAG_API_QUERY_LIMIT = 0;
const DEFAULT_REFRESH_FRESHNESS_DAYS = 30;
// Public Spider capture is a bounded supplemental path. Keep its full budget
// below the API deadline so an abandoned upstream request never ties up work.
// A manual hot capture is an interactive operation.  Keep the entire public
// page collection bounded to the UI promise instead of letting a slow source
// monopolise Chromium after the caller has already timed out.
const SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS = 30_000;
const SENTIMENT_HOT_TOTAL_TIMEOUT_MS = 40_000;
export function resolveSentimentHotReaderTotalTimeoutMs(
  value: unknown = process.env.SENTIMENT_HOT_READER_TOTAL_TIMEOUT_MS,
): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(20_000, Math.min(parsed, 90_000)) : 90_000;
}
const SENTIMENT_HOT_READER_ONLY_TOTAL_TIMEOUT_MS = resolveSentimentHotReaderTotalTimeoutMs();
const SENTIMENT_HOT_REFRESH_STRATEGY_TIMEOUT_MS = 8_000;
const SENTIMENT_HOT_STRICT_PARENT_SUPPLEMENT_LIMIT = 8;
const SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const SENTIMENT_HOT_MAX_PUBLISHED_AGE_MS = 730 * 24 * 60 * 60 * 1000;
const SENTIMENT_HOT_SEARCH_STRATEGY_VERSION = 50;
const SENTIMENT_HOT_TIMEOUT_WARNING = "\u71b1\u9ede\u6293\u53d6\u5df2\u8d85\u6642\uff0c\u5df2\u505c\u6b62\u5f8c\u7e8c\u8017\u6642\u6b65\u9a5f\uff1b\u8acb\u7a0d\u5f8c\u5237\u65b0\u6216\u6aa2\u67e5 Cookie / sessionid\u3002";
const THREADS_SEARCH_CACHE_WARNING = "当前 Threads 搜索被限流，已使用 24 小时内缓存热点。";
const SENTIMENT_HOT_NORMAL_KEYWORD_TARGET = 28;
const SENTIMENT_HOT_STRICT_KEYWORD_TARGET = 20;
const SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE = resolveRuntimeFile("sentiment_hot_search_strategy_cache.json");
const SENTIMENT_HOT_GLOBAL_POOL_FILE = resolveRuntimeFile("sentiment_hot_global_pool.json");
const SENTIMENT_HOT_GLOBAL_POOL_DB_FILE = resolveRuntimeFile("sentiment_hot_global_pool.sqlite3");
const SENTIMENT_HOT_GLOBAL_POOL_LIMIT = 100_000;
const SENTIMENT_HOT_GLOBAL_POOL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const THREADS_SEARCH_GRAPHQL_TEMPLATE_CACHE_FILE = resolveRuntimeFile("threads_search_graphql_template_cache.json");
const SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SENTIMENT_HOT_SEMANTIC_RELEVANCE_VERSION = 4;
// Re-showing a compliant post is allowed only after fresh/unshown candidates
// are exhausted. The cooldown keeps manual refreshes from showing the same
// item back-to-back while still allowing a small persona pool to reach ten.
const SENTIMENT_HOT_REPEAT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SENTIMENT_HOT_REPEAT_ROTATION_BUCKET_MS = 10 * 60 * 1000;
const THREADS_GRAPHQL_UPSTREAM_KEY = "threads.com:graphql";
const INSTAGRAM_AUTH_UPSTREAM_KEY = "instagram.com:authenticated";
const SHARED_READER_UPSTREAM_KEY = "spider-http:public-reader";
const SPIDER_HTTP_CLI_PATH = process.env.TG_HOT_SPIDER_CLI_PATH || "/worker-runtime/spider";
// The shared limiter is fixed for the lifetime of this one-job Node process.
// The worker assigns either the interactive or background-refill profile.
const SPIDER_HTTP_MAX_CONCURRENCY = SENTIMENT_HOT_READER_CONCURRENCY;
const ANONYMOUS_READER_PROXY_CONFIG_PATH = process.env.COLLECTOR_PROXY_CONFIG_PATH || "/collector-proxy/config.json";
const ANONYMOUS_READER_JITTER_MIN_MS = 1_000;
const ANONYMOUS_READER_JITTER_MAX_MS = 5_000;
// Never retry a blocked public request on the same connection. Login walls,
// throttling and network timeouts terminate that Spider process, then one
// fresh process is launched through the next proxy selection. A rotating
// product therefore reconnects with a fresh provider exit.
const ANONYMOUS_READER_MAX_ATTEMPTS = 2;

type AnonymousReaderProxyConfig = {
  url: string;
  rotationEpoch: number;
  productId: string;
};

type AnonymousReaderProxyPool = {
  proxies: AnonymousReaderProxyConfig[];
  revision: number;
  required: boolean;
};

let anonymousReaderProxyCursor = 0;
let anonymousReaderProxyRevision = -1;

export function resolveAnonymousReaderJitterMaxMs(
  value: unknown = process.env.SENTIMENT_HOT_READER_JITTER_MAX_MS,
): number {
  if (value === undefined || value === null || String(value).trim() === "") {
    return ANONYMOUS_READER_JITTER_MAX_MS;
  }
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, ANONYMOUS_READER_JITTER_MAX_MS)) : ANONYMOUS_READER_JITTER_MAX_MS;
}

export function resolveAnonymousReaderMaxAttempts(
  value: unknown = process.env.SENTIMENT_HOT_READER_MAX_ATTEMPTS,
): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 2)) : ANONYMOUS_READER_MAX_ATTEMPTS;
}

export function resolveAnonymousReaderJitterMs(randomValue = Math.random()): number {
  const maxMs = resolveAnonymousReaderJitterMaxMs();
  if (maxMs <= 0) return 0;
  const minMs = maxMs >= ANONYMOUS_READER_JITTER_MIN_MS ? ANONYMOUS_READER_JITTER_MIN_MS : 0;
  const bounded = Math.max(0, Math.min(0.999999, Number.isFinite(randomValue) ? randomValue : 0));
  return minMs + Math.floor(bounded * (maxMs - minMs + 1));
}

export function readerBodyHasUsablePostLinks(body: unknown): boolean {
  const text = String(body || "");
  return /https?:\/\/(?:www\.)?threads\.(?:com|net)\/@[^\s/)]+\/post\/[A-Za-z0-9_-]+/i.test(text)
    || /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+/i.test(text);
}

export function threadsHtmlLooksLikeEmptySearch(value: unknown): boolean {
  const text = String(value || "");
  if (!text) return false;
  if (/(?:查無結果|没有结果|沒有結果|No results)/i.test(text)) return true;
  const marker = text.indexOf('{"data":{"searchResults"');
  if (marker < 0) return false;
  return /"edges"\s*:\s*\[\s*\]/.test(text.slice(marker, marker + 280));
}

export function readerBodyLooksLikeLoginWall(body: unknown): boolean {
  const text = String(body || "");
  if (/requiring CAPTCHA|captcha/i.test(text)) return true;
  // Logged-out search chrome always mentions login. A real SERP — including
  // Threads' explicit empty-result payload — is not a login wall.
  if (threadsHtmlLooksLikeEmptySearch(text)) return false;
  if (text.includes("thread_items") || text.includes("text_post_app_info")) return false;
  const hasLoginPrompt = /log into instagram|\u767b\u5165 Instagram|\u767b\u5f55 Instagram|continue to instagram|log in for more threads|log in or sign up for threads/i.test(text);
  return hasLoginPrompt && !readerBodyHasUsablePostLinks(text);
}

export function anonymousReaderRetryReason(value: ReaderResponseSnapshot): string {
  const status = Math.floor(Number(value?.status || 0));
  if ([401, 403, 407, 451].includes(status)) return `blocked_${status}`;
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return `upstream_${status}`;
  if (/bad gateway|gateway timeout|service unavailable/i.test(String(value?.body || ""))) return "upstream_failure";
  if (readerBodyLooksLikeLoginWall(value?.body)) return "login_wall_or_challenge";
  if (readerMarkdownLooksEmpty(value?.body)) return "empty_public_page";
  return "";
}

export function isRetryableAnonymousReaderError(error: unknown): boolean {
  return /timeout|timed\s*out|abort|fetch failed|econnreset|econnrefused|socket|network/i.test(
    error instanceof Error ? error.message : String(error || ""),
  );
}

function stripReaderStickySession(value: unknown): string {
  return String(value || "").replace(/(?:_session-|-session-)[A-Za-z0-9]+(?:_ttl-\d+)?$/i, "");
}

function anonymousReaderProxyFromValue(value: any, fallbackId = "legacy"): AnonymousReaderProxyConfig | null {
  const protocol = String(value?.protocol || "http").trim().toLowerCase();
  if (protocol !== "http" && protocol !== "https") return null;
  const host = String(value?.host || "").trim();
  const port = Math.floor(Number(value?.port || 0));
  if (!host || port < 1 || port > 65535) return null;
  const username = encodeURIComponent(stripReaderStickySession(value?.username));
  const password = encodeURIComponent(stripReaderStickySession(value?.password));
  const auth = username || password ? `${username}:${password}@` : "";
  return {
    url: `${protocol}://${auth}${host}:${port}`,
    rotationEpoch: Math.max(0, Math.floor(Number(value?.reader_rotation_epoch || 0))),
    productId: String(value?.proxy_id || value?.provider_proxy_id || fallbackId),
  };
}

function readAnonymousReaderProxyPool(): AnonymousReaderProxyPool {
  try {
    const value = JSON.parse(fs.readFileSync(ANONYMOUS_READER_PROXY_CONFIG_PATH, "utf8"));
    if (!value || typeof value !== "object") return { proxies: [], revision: 0, required: false };
    if (Array.isArray(value.products)) {
      const proxies = value.products.flatMap((item: any) => {
        const check = item?.last_check && typeof item.last_check === "object" ? item.last_check : {};
        const fingerprint = String(item?.connection_fingerprint || "");
        const verified = check.ok === true && fingerprint && String(check.connection_fingerprint || "") === fingerprint;
        if (item?.public_reader_enabled !== true || item?.state !== "active" || !verified) return [];
        const parsed = anonymousReaderProxyFromValue(item);
        return parsed ? [parsed] : [];
      });
      return {
        proxies,
        revision: Math.max(0, Math.floor(Number(value.reader_pool_revision || value.revision || 0))),
        required: value.public_reader_enabled === true,
      };
    }
    if (value.public_reader_enabled !== true || value.state !== "active") {
      return { proxies: [], revision: 0, required: false };
    }
    const proxy = anonymousReaderProxyFromValue(value);
    return {
      proxies: proxy ? [proxy] : [],
      revision: Math.max(0, Math.floor(Number(value.reader_rotation_epoch || 0))),
      required: true,
    };
  } catch {
    return { proxies: [], revision: 0, required: false };
  }
}

function takeNextAnonymousReaderProxy(pool: AnonymousReaderProxyPool): AnonymousReaderProxyConfig | null {
  if (!pool.proxies.length) return null;
  if (anonymousReaderProxyRevision !== pool.revision) {
    anonymousReaderProxyRevision = pool.revision;
    anonymousReaderProxyCursor = Math.abs((process.pid + pool.revision) % pool.proxies.length);
  }
  const proxy = pool.proxies[anonymousReaderProxyCursor % pool.proxies.length] || null;
  anonymousReaderProxyCursor = (anonymousReaderProxyCursor + 1) % pool.proxies.length;
  return proxy;
}
const threadsGraphqlRateLimiter = new AdaptiveHotRateLimiter({
  maxConcurrency: 12,
  initialConcurrency: 2,
  minConcurrency: 1,
  baseBackoffMs: 750,
  maxBackoffMs: 30_000,
  recoverySuccessThreshold: 3,
});
const instagramAuthenticatedRateLimiter = new AdaptiveHotRateLimiter({
  maxConcurrency: INSTAGRAM_AUTHENTICATED_QUERY_BATCH_SIZE,
  initialConcurrency: INSTAGRAM_AUTHENTICATED_QUERY_BATCH_SIZE,
  minConcurrency: 1,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  recoverySuccessThreshold: 3,
});
const sharedReaderRateLimiter = new AdaptiveHotRateLimiter({
  maxConcurrency: SPIDER_HTTP_MAX_CONCURRENCY,
  initialConcurrency: SPIDER_HTTP_MAX_CONCURRENCY,
  minConcurrency: SPIDER_HTTP_MAX_CONCURRENCY,
  baseBackoffMs: 750,
  maxBackoffMs: 30_000,
  recoverySuccessThreshold: 4,
});
const PUBLIC_READER_RENDER_MAX_CONCURRENCY = 1;
const PUBLIC_READER_RENDER_QUERY_LIMIT = 1;
const publicReaderRenderLimiter = new AdaptiveHotRateLimiter({
  maxConcurrency: PUBLIC_READER_RENDER_MAX_CONCURRENCY,
  initialConcurrency: PUBLIC_READER_RENDER_MAX_CONCURRENCY,
  minConcurrency: 1,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  recoverySuccessThreshold: 2,
});
const sharedReaderResponseCoordinator = createReaderResponseCoordinator({
  freshTtlMs: 5 * 60_000,
  staleTtlMs: 10 * 60_000,
  maxEntries: 200,
  storageDir: resolveRuntimeFile("sentiment_reader_response_cache"),
});

export function resolveSentimentHotStrategyTimeoutMs(refresh: boolean, remainingMs: number): number {
  const availableMs = Number.isFinite(remainingMs) ? Math.max(1_000, remainingMs) : 1_000;
  return Math.min(SENTIMENT_HOT_REFRESH_STRATEGY_TIMEOUT_MS, availableMs);
}

const SENTIMENT_HOT_GENERIC_QUERY_INTENTS = [
  "經驗",
  "心得",
  "案例",
  "避坑",
  "攻略",
  "整理",
  "懶人包",
  "申請",
  "比較",
  "風險",
  "計畫",
  "计划",
  "教程",
  "教學",
  "教学",
  "活動",
  "活动",
  "指南",
  "指導",
  "指导",
  "方法",
  "步驟",
  "步骤",
  "清單",
  "清单",
  "翻車",
  "翻车",
  "踩雷",
  "吐槽",
  "互動",
  "互动",
  "趣事",
  "手藝",
  "手艺",
  "工具",
  "場景",
  "场景",
  "痛點",
  "痛点",
];

function resolvePlaywrightChromeExecutables(): string[] {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/ms-playwright",
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const found: string[] = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        const chrome = path.join(root, entry, "chrome-linux64", "chrome");
        const shell = path.join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
        if (fs.existsSync(chrome)) found.push(chrome);
        if (fs.existsSync(shell)) found.push(shell);
      }
    } catch {
      // Keep looking through the remaining Playwright browser roots.
    }
  }
  return found;
}

function resolvePreferredChromeExecutablePath(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.TG_HOT_SPIDER_CHROME_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    ...resolvePlaywrightChromeExecutables(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function resolveThreadsAuthProxy() {
  const server = String(process.env.THREADS_AUTH_PROXY_SERVER || "").trim();
  const username = String(process.env.THREADS_AUTH_PROXY_USERNAME || "").trim();
  const password = String(process.env.THREADS_AUTH_PROXY_PASSWORD || "");
  const required = String(process.env.TG_COLLECTOR_AUTH_PROXY_REQUIRED || "").trim() === "1";
  if (!server) {
    if (required) throw new Error("collector account sticky proxy is required but unavailable");
    return undefined;
  }
  if (!username || !password) {
    throw new Error("collector account sticky proxy credentials are incomplete");
  }
  return { server, username, password };
}

function buildLocalChromiumLaunchOptions() {
  const executablePath = resolvePreferredChromeExecutablePath();
  const proxy = resolveThreadsAuthProxy();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxy ? { proxy } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
}

export function boundedBrowserPageConcurrency(requested = 2): number {
  const configured = Number(process.env.SENTIMENT_BROWSER_PAGE_CONCURRENCY || 2);
  const serverLimit = Number.isFinite(configured)
    ? Math.min(2, Math.max(1, Math.floor(configured)))
    : 2;
  const cleanRequested = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : 1;
  return Math.min(serverLimit, cleanRequested);
}

export function sentimentHotCandidatePoolLimits() {
  return {
    readyTarget: SENTIMENT_HOT_CANDIDATE_POOL_TARGET,
    perRowLimit: THREADS_SEARCH_CACHE_CANDIDATE_LIMIT,
    maxRowsPerArchive: THREADS_SEARCH_CACHE_MAX_ROWS_PER_ARCHIVE,
    globalLimit: SENTIMENT_HOT_GLOBAL_POOL_LIMIT,
  };
}

export function planThreadsBrowserDomQueryLanes(
  values: string[],
  requestedPages = THREADS_BROWSER_PAGE_LIMIT,
  bootstrapCount = 1,
): { bootstrapQueries: string[]; queryLanes: string[][] } {
  const queries = [...new Set(values.map(cleanText).filter(Boolean))].slice(0, THREADS_BROWSER_QUERY_LIMIT);
  const cleanBootstrapCount = Math.min(queries.length, Math.max(0, Math.floor(bootstrapCount)));
  const bootstrapQueries = queries.slice(0, cleanBootstrapCount);
  const remainingQueries = queries.slice(bootstrapQueries.length);
  if (remainingQueries.length === 0) return { bootstrapQueries, queryLanes: [] };
  const laneCount = Math.min(boundedBrowserPageConcurrency(requestedPages), remainingQueries.length);
  const queryLanes = Array.from({ length: laneCount }, () => [] as string[]);
  remainingQueries.forEach((query, index) => queryLanes[index % laneCount].push(query));
  return { bootstrapQueries, queryLanes };
}

export function shouldUseThreadsSearchGraphqlTemplate(args: {
  publicOnly: boolean;
  authenticated: boolean;
  collectorProfileRequired: boolean;
}): boolean {
  return !args.publicOnly && !(args.authenticated && args.collectorProfileRequired);
}

let sentimentBrowserWorkActive = 0;
const sentimentBrowserWorkQueue: Array<() => void> = [];

/**
 * Acquires one bounded browser slot.  A timed-out public search must be
 * removed from the queue, otherwise its orphaned waiter can start Chromium
 * after the caller has already returned and delay the next interactive run.
 */
export async function acquireSentimentBrowserWorkSlot(options: { timeoutMs?: number } = {}): Promise<() => void> {
  const maxActive = boundedBrowserPageConcurrency(2);
  if (sentimentBrowserWorkActive >= maxActive) {
    const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs) || 0));
    const acquired = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      sentimentBrowserWorkQueue.push(waiter);
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        const index = sentimentBrowserWorkQueue.indexOf(waiter);
        if (index >= 0) sentimentBrowserWorkQueue.splice(index, 1);
        resolve(false);
      }, timeoutMs);
    });
    if (!acquired) throw new Error("sentiment_browser_slot_timeout");
  }
  sentimentBrowserWorkActive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sentimentBrowserWorkActive = Math.max(0, sentimentBrowserWorkActive - 1);
    const next = sentimentBrowserWorkQueue.shift();
    if (next) queueMicrotask(next);
  };
}

async function addCookiesBestEffort(context: any, cookies: any[]) {
  const usable = (cookies || []).filter((cookie) => cookie?.name && cookie?.value && cookie?.domain);
  if (!usable.length) return;
  const ok = await context.addCookies(usable as any).then(() => true).catch(() => false);
  if (ok) return;
  for (const cookie of usable) {
    await context.addCookies([cookie] as any).catch(() => undefined);
  }
}

export type SentimentCookieHealth = "healthy" | "watch" | "degraded" | "expired" | "missing" | "unknown";
export type SentimentHotSearchMode = "normal" | "strict";
export type SentimentHotFreshnessPolicy = "legacy" | "strict";

export function normalizeSentimentHotFreshnessPolicy(value: unknown): SentimentHotFreshnessPolicy {
  return String(value || "").trim().toLowerCase() === "strict" ? "strict" : "legacy";
}

export function normalizeRequestedHotPlatform(value: unknown): SentimentHotPlatform | undefined {
  const text = String(value || "").trim().toLowerCase();
  if (text === "instagram") return "instagram";
  if (text === "threads") return "threads";
  return undefined;
}

export function resolveHotLiveFetchTargets(platform?: unknown): { threads: boolean; instagram: boolean } {
  const requested = normalizeRequestedHotPlatform(platform) ?? "threads";
  return {
    threads: requested === "threads",
    instagram: requested === "instagram",
  };
}

function candidateMatchesRequestedPlatform(
  candidate: { platform?: string },
  platform?: SentimentHotPlatform,
): boolean {
  if (!platform) return true;
  return String(candidate.platform || "").trim().toLowerCase() === platform;
}

export interface SentimentCookieStatus {
  platform: SentimentHotPlatform;
  profileKey?: string;
  health: SentimentCookieHealth;
  label: string;
  message: string;
  validCookieCount?: number;
  expiredCookieCount?: number;
  sessionCookieCount?: number;
  expiringSoonCookieCount?: number;
  hasRequiredSessionCookie?: boolean;
  authorizationNeedsRefresh?: boolean;
  recommendedAction?: string;
  lastAuthorizedAt?: string | null;
  liveCheckedAt?: string;
}

export interface FetchSentimentHotCandidatesResult {
  candidates: SentimentHotCandidate[];
  keywords: string[];
  searchMode: SentimentHotSearchMode;
  freshnessDays: number;
  freshnessPolicy: SentimentHotFreshnessPolicy;
  cookieStatuses: SentimentCookieStatus[];
  warnings: string[];
}

export interface PrepareSentimentHotKeywordsResult {
  keywords: string[];
  searchMode: SentimentHotSearchMode;
  warnings: string[];
}

export interface SentimentHotSearchStrategy {
  primaryQueries: string[];
  broadQueries: string[];
  ecosystemQueries: string[];
  requiredAnchorTerms: string[];
  normalAnchorTerms: string[];
  strictAcceptTerms: string[];
  normalAcceptTerms: string[];
  rejectTerms: string[];
  domainSummary?: string;
  personaGuardTerms?: string[];
}

export interface ThreadsBrowserProfilePublishedPostSnapshot {
  sourceUrl: string;
  hotScore: number;
  metrics: Record<string, unknown>;
  engagement: NonNullable<SentimentHotCandidate["engagement"]>;
  capturedAt: string;
}

export type ThreadsProfilePostHotMetrics = {
  pk?: string;
  code?: string;
  sourceUrl: string;
  content?: string;
  publishedAt?: string;
  likeCount?: number;
  commentCount?: number;
  repostCount?: number;
  shareCount?: number;
  viewCount?: number;
  capturedAt?: string;
};

export type ThreadsProfileHotMetrics = {
  platform: "threads";
  username: string;
  followers?: number;
  following?: number;
  recentViews?: number;
  posts?: number;
  likes?: number;
  comments?: number;
  reposts?: number;
  shares?: number;
  views?: number;
  viewResolvedPosts?: number;
  viewMissingPosts?: number;
  scannedPosts?: number;
  refreshedAt: string;
  method: "http" | "browser" | "reader" | "failed";
  complete?: boolean;
  scope?: "authenticated_full_profile" | "public_partial" | "reader_public_partial" | "profile_visible_light" | "failed";
  lightRefreshedAt?: string;
  postMetrics?: ThreadsProfilePostHotMetrics[];
  rawText?: string;
  error?: string;
};

export type InstagramProfileHotMetrics = {
  platform: "instagram";
  username: string;
  followers?: number;
  following?: number;
  posts?: number;
  likes?: number;
  comments?: number;
  reposts?: number;
  shares?: number;
  views?: number;
  scannedPosts?: number;
  refreshedAt: string;
  method: "http" | "browser" | "failed";
  complete?: boolean;
  scope?: "authenticated_full_profile" | "authenticated_profile_snapshot" | "failed";
  postMetrics?: ThreadsProfilePostHotMetrics[];
  error?: string;
};

function cleanText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeThreadsTimestamp(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && /\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const millis = numeric > 100000000000 ? numeric : numeric * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeJson(value: unknown): any {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    const raw = String(value);
    const objectIndex = raw.indexOf("{");
    const arrayIndex = raw.indexOf("[");
    const first = objectIndex >= 0 && arrayIndex >= 0
      ? Math.min(objectIndex, arrayIndex)
      : Math.max(objectIndex, arrayIndex);
    if (first < 0) return {};
    try {
      return JSON.parse(raw.slice(first));
    } catch {
      return {};
    }
  }
}

function splitKeywords(value: string): string[] {
  return value
    .split(/[,，、。.!！?？；;：:\s#]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 24)
    .slice(0, 12);
}

function hasHan(value: unknown): boolean {
  return /[\u3400-\u9fff]/u.test(String(value || ""));
}

function isSearchableRelevanceTerm(value: unknown): boolean {
  const text = cleanText(value);
  return hasHan(text) || /^[A-Za-z][A-Za-z0-9.+-]{2,20}$/.test(text);
}

const SENTIMENT_HOT_SCRIPT_VARIANT_PAIRS: Array<[string, string]> = [
  ["發", "发"],
  ["髮", "发"],
  ["頭", "头"],
  ["後", "后"],
  ["師", "师"],
  ["價", "价"],
  ["體", "体"],
  ["驗", "验"],
  ["實", "实"],
  ["場", "场"],
  ["業", "业"],
  ["動", "动"],
  ["對", "对"],
  ["設", "设"],
  ["計", "计"],
  ["車", "车"],
  ["輛", "辆"],
  ["維", "维"],
  ["養", "养"],
  ["廠", "厂"],
  ["檢", "检"],
  ["費", "费"],
  ["評", "评"],
  ["薦", "荐"],
  ["顧", "顾"],
  ["選", "选"],
  ["擇", "择"],
  ["務", "务"],
  ["點", "点"],
  ["燙", "烫"],
  ["麼", "么"],
  ["會", "会"],
  ["還", "还"],
  ["這", "这"],
  ["個", "个"],
  ["與", "与"],
];

function expandChineseScriptVariants(value: string): string[] {
  const text = cleanText(value);
  if (!text || !hasHan(text)) return [];
  const toSimplified = new Map<string, string>();
  const toTraditional = new Map<string, string>();
  for (const [traditional, simplified] of SENTIMENT_HOT_SCRIPT_VARIANT_PAIRS) {
    toSimplified.set(traditional, simplified);
    if (!toTraditional.has(simplified)) toTraditional.set(simplified, traditional);
  }
  const convert = (source: string, table: Map<string, string>) => Array.from(source)
    .map((char) => table.get(char) || char)
    .join("");
  const variants = new Set<string>([text, convert(text, toSimplified), convert(text, toTraditional)]);
  const replaceAllText = (source: string, from: string, to: string) => source.split(from).join(to);
  for (const [traditional, simplified] of SENTIMENT_HOT_SCRIPT_VARIANT_PAIRS) {
    if (text.includes(traditional)) variants.add(replaceAllText(text, traditional, simplified));
    if (text.includes(simplified)) variants.add(replaceAllText(text, simplified, traditional));
  }
  return [...variants].map(cleanText).filter(Boolean);
}

function expandSentimentSearchKeywordVariants(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (item: string) => {
    const text = cleanText(item);
    if (!text || !hasHan(text)) return;
    if (text.length < 2 || text.length > 12) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    if (isGenericSentimentKeyword(text) || WEAK_RELEVANCE_STOPWORDS.has(text) || WEAK_RELEVANCE_STOPWORDS.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  const text = cleanText(value);
  for (const variant of expandChineseScriptVariants(text)) add(variant);
  return out;
}

function readSentimentBrowserFallbackConfig() {
  const configPath = resolveSentimentConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    const config = parseSentimentConfigJson(fs.readFileSync(configPath, "utf8"));
    const fallback = config?.sentimentSearch?.browserFallback || config?.browserFallback || {};
    return fallback && typeof fallback === "object" ? fallback : {};
  } catch {
    return {};
  }
}

function parseSentimentConfigJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const first = raw.indexOf("{");
    if (first < 0) throw error;
    let inString = false;
    let escaped = false;
    let depth = 0;
    for (let index = first; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(raw.slice(first, index + 1));
      }
    }
    throw error;
  }
}

function readSentimentBrowserAuthProfilesConfig(): any[] {
  const fallback = readSentimentBrowserFallbackConfig();
  return Array.isArray((fallback as any).profiles)
    ? (fallback as any).profiles.map(normalizeSentimentBrowserAuthProfile)
    : [];
}

function normalizeSentimentBrowserAuthProfile(profile: any): any {
  if (!profile || typeof profile !== "object") return profile;
  const key = cleanText(profile.key || profile.platform || profile.sourceKey).toLowerCase();
  if (key !== "threads") return profile;
  return {
    ...profile,
    domain: "threads.com",
    authUrl: "https://www.threads.com/",
    authUrls: ["https://www.threads.com/", "https://www.threads.net/", "https://www.instagram.com/accounts/login/"],
    cookieDomains: ["threads.com", "threads.net", "instagram.com", "facebook.com"],
    matchDomains: ["threads.com", "threads.net"],
    urlTemplate: "https://www.threads.com/search?q={query}",
    linkPattern: "threads.com/",
  };
}

function readSentimentBrowserAuthToken(): string {
  const fallback = readSentimentBrowserFallbackConfig();
  return cleanText((fallback as any).authHelperToken || "");
}

function sentimentProfileMatchesPlatform(profile: any, platform: SentimentHotPlatform) {
  return profile?.platform === platform || profile?.sourceKey === platform || profile?.key === platform;
}

function hasValidCookieNamed(cookies: any[], name: string) {
  const target = String(name || "").toLowerCase();
  const nowSeconds = Date.now() / 1000;
  return (cookies || []).some((cookie: any) => {
    const expires = Number(cookie?.expires);
    return String(cookie?.name || "").toLowerCase() === target
      && String(cookie?.value || "").trim().length > 0
      && (!Number.isFinite(expires) || expires <= 0 || expires > nowSeconds);
  });
}

function cookieDomainMatchesAny(cookie: any, domains: string[]) {
  const raw = String(cookie?.domain || "").trim().toLowerCase().replace(/^\.+/, "");
  if (!raw) return false;
  return domains.some((domain) => raw === domain || raw.endsWith(`.${domain}`));
}

function hasValidThreadsSessionCookie(cookies: any[]) {
  const targetDomains = ["threads.net", "threads.com"];
  const nowSeconds = Date.now() / 1000;
  return (cookies || []).some((cookie: any) => {
    const expires = Number(cookie?.expires);
    return String(cookie?.name || "").toLowerCase() === "sessionid"
      && String(cookie?.value || "").trim().length > 0
      && cookieDomainMatchesAny(cookie, targetDomains)
      && (!Number.isFinite(expires) || expires <= 0 || expires > nowSeconds);
  });
}

function hasValidInstagramSessionCookie(cookies: any[]) {
  const nowSeconds = Date.now() / 1000;
  return (cookies || []).some((cookie: any) => {
    const expires = Number(cookie?.expires);
    return String(cookie?.name || "").toLowerCase() === "sessionid"
      && String(cookie?.value || "").trim().length > 0
      && cookieDomainMatchesAny(cookie, ["instagram.com"])
      && (!Number.isFinite(expires) || expires <= 0 || expires > nowSeconds);
  });
}

function hasValidThreadsSessionCookieForDomain(cookies: any[], domain: "threads.com" | "threads.net") {
  const nowSeconds = Date.now() / 1000;
  return (cookies || []).some((cookie: any) => {
    const expires = Number(cookie?.expires);
    return String(cookie?.name || "").toLowerCase() === "sessionid"
      && String(cookie?.value || "").trim().length > 0
      && cookieDomainMatchesAny(cookie, [domain])
      && (!Number.isFinite(expires) || expires <= 0 || expires > nowSeconds);
  });
}

function buildSentimentCookieStatusFromProfile(platform: SentimentHotPlatform, profile: any): SentimentCookieStatus {
  const cookies = Array.isArray(profile?.cookies) ? profile.cookies.filter((item: any) => item && typeof item === "object") : [];
  const nowSeconds = Date.now() / 1000;
  let valid = 0;
  let expired = 0;
  let session = 0;
  let expiringSoon = 0;
  let hasLoginSession = false;
  for (const cookie of cookies) {
    if (!cookie?.name || !cookie?.value) continue;
    const expires = Number(cookie.expires);
    if (String(cookie.name || "").toLowerCase() === "sessionid") hasLoginSession = true;
    if (!Number.isFinite(expires) || expires <= 0) {
      valid += 1;
      session += 1;
    } else if (expires <= nowSeconds) {
      expired += 1;
    } else {
      valid += 1;
      if (expires <= nowSeconds + 7 * 24 * 60 * 60) expiringSoon += 1;
    }
  }
  const hasRequiredSessionCookie = platform === "threads"
    ? hasValidThreadsSessionCookie(cookies)
    : hasValidInstagramSessionCookie(cookies);
  const missingLoginSession = valid > 0 && !hasRequiredSessionCookie;
  const health: SentimentCookieHealth = cookies.length === 0
    ? "missing"
    : valid <= 0
      ? "expired"
      : missingLoginSession || expired > 0
        ? "degraded"
        : expiringSoon > 0
          ? "watch"
          : "healthy";
  const recommendedAction = health === "missing"
    ? "authorize-profile"
    : health === "expired"
      ? "reauthorize-profile"
      : health === "degraded"
        ? "refresh-profile-cookies"
        : health === "watch"
          ? "refresh-before-expiry"
          : "keep";
  return {
    platform,
    profileKey: cleanText(profile?.key || profile?.sourceKey || platform) || platform,
    health,
    label: platform === "threads" ? "Threads" : "Instagram",
    validCookieCount: valid,
    expiredCookieCount: expired,
    sessionCookieCount: session,
    expiringSoonCookieCount: expiringSoon,
    hasRequiredSessionCookie,
    authorizationNeedsRefresh: recommendedAction !== "keep",
    recommendedAction,
    lastAuthorizedAt: profile?.lastAuthorizedAt || null,
    message: profile
      ? `有效 Cookie ${valid} 個，過期 ${expired} 個。`
      : "缺少授權 Cookie，請到快捷配置頁面刷新。",
  };
}

export function getSentimentBrowserAuthProfileBinding(platform: SentimentHotPlatform): SentimentCookieStatus {
  const profile = readSentimentBrowserAuthProfilesConfig().find((item: any) => sentimentProfileMatchesPlatform(item, platform));
  if (platform !== "threads") return buildSentimentCookieStatusFromProfile(platform, profile);
  const managedCookies = readManagedThreadsAccountCookies();
  if (!hasValidThreadsSessionCookie(managedCookies)) return buildSentimentCookieStatusFromProfile(platform, profile);
  return buildSentimentCookieStatusFromProfile(platform, {
    ...(profile || {}),
    key: profile?.key || "threads",
    cookies: managedCookies,
  });
}

const liveSentimentBrowserAuthStatusCache = new Map<string, { expiresAt: number; status: SentimentCookieStatus }>();

function buildSentimentCookieLiveFailureStatus(status: SentimentCookieStatus, message: string): SentimentCookieStatus {
  return {
    ...status,
    health: status.health === "missing" ? "missing" : "degraded",
    hasRequiredSessionCookie: false,
    authorizationNeedsRefresh: true,
    recommendedAction: status.health === "missing" ? "authorize-profile" : "reauthorize-profile",
    liveCheckedAt: new Date().toISOString(),
    message,
  };
}

export async function getLiveSentimentBrowserAuthProfileBinding(platform: SentimentHotPlatform, options?: { maxAgeMs?: number }): Promise<SentimentCookieStatus> {
  const status = getSentimentBrowserAuthProfileBinding(platform);
  if (platform !== "threads" || process.env.VITEST_WORKER_ID) return status;
  const maxAgeMs = Math.max(0, Number(options?.maxAgeMs ?? 60_000));
  const cacheKey = `${platform}:${status.profileKey || platform}`;
  const cached = liveSentimentBrowserAuthStatusCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const cookies = readSentimentBrowserAuthCookies(platform)
    .map((cookie: any) => normalizeCookieForBrowserAuth(cookie, "threads.com"))
    .filter(Boolean);
  if (!hasValidThreadsSessionCookieForDomain(cookies, "threads.com")) {
    const next = buildSentimentCookieLiveFailureStatus(status, "Threads 已保存 Cookie，但缺少可用的 threads.com sessionid；请重新登录 Threads 后用授权助手同步。");
    liveSentimentBrowserAuthStatusCache.set(cacheKey, { expiresAt: Date.now() + maxAgeMs, status: next });
    return next;
  }

  let browser: any = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch(buildLocalChromiumLaunchOptions());
    const context = await browser.newContext({
      locale: "zh-TW",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    await addCookiesBestEffort(context, cookies as any[]);
    const page = await context.newPage();
    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(1500);
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const href = page.url();
    const refreshedCookies = activeUniqueCookies((await context.cookies(["https://www.threads.com/", "https://www.threads.net/"]))
      .map((cookie) => normalizeCookieForBrowserAuth(cookie, "threads.com"))
      .filter(Boolean));
    await context.close().catch(() => undefined);
    const loginWall = /accounts\/login|log in|login|登入|登录|使用 Instagram|Instagram 帳號|Instagram 账号/i.test(`${title}\n${href}\n${bodyText}`);
    const retainedThreadsComSession = hasValidThreadsSessionCookieForDomain(refreshedCookies, "threads.com");
    const next = loginWall || !retainedThreadsComSession
      ? buildSentimentCookieLiveFailureStatus(status, "Threads sessionid 已保存，但实时打开 Threads 后未保持真实登录态；请在授权助手里重新登录并同步。")
      : { ...status, health: status.health === "missing" ? "missing" : "healthy", hasRequiredSessionCookie: true, authorizationNeedsRefresh: false, recommendedAction: "keep", liveCheckedAt: new Date().toISOString(), message: `${status.message}；实时登录态可用。` };
    liveSentimentBrowserAuthStatusCache.set(cacheKey, { expiresAt: Date.now() + maxAgeMs, status: next });
    return next;
  } catch (error: any) {
    const next = buildSentimentCookieLiveFailureStatus(status, `Threads 实时授权探测失败：${error instanceof Error ? error.message : String(error || "unknown")}`);
    liveSentimentBrowserAuthStatusCache.set(cacheKey, { expiresAt: Date.now() + Math.min(maxAgeMs, 15_000), status: next });
    return next;
  } finally {
    await browser?.close?.().catch?.(() => undefined);
  }
}

function segmentPersonaWords(value: string): string[] {
  const text = cleanText(value);
  if (!text || !hasHan(text)) return [];
  const out: string[] = [];
  const add = (word: string) => {
    const item = cleanText(word);
    if (!item || !hasHan(item)) return;
    if (item.length < 2 || item.length > 12) return;
    if (isGenericSentimentKeyword(item)) return;
    if (WEAK_RELEVANCE_STOPWORDS.has(item)) return;
    if (!out.some((existing) => existing.toLowerCase() === item.toLowerCase())) out.push(item);
  };
  try {
    const Segmenter = (Intl as any).Segmenter;
    if (Segmenter) {
      const segmenter = new Segmenter("zh-Hant", { granularity: "word" });
      for (const part of segmenter.segment(text)) {
        if (part?.isWordLike) add(part.segment);
      }
    }
  } catch {
    // Intl.Segmenter is optional in older Node runtimes.
  }
  return out;
}

const GENERIC_SENTIMENT_KEYWORDS = new Set([
  "threads",
  "instagram",
  "thread",
  "ig",
  "生活",
  "情緒",
  "日常",
  "熱門",
  "熱點",
  "分享",
  "台灣",
  "心情",
  "今天",
  "最近",
  "追劇",
  "話題",
  "討論",
  "推薦",
  "好笑",
  "實用",
  "推文",
  "文案",
  "文化",
  "體驗",
  "体验",
  "使用",
  "搞笑",
  "吐槽",
  "段子",
  "趣事",
  "職場",
  "职场",
]);

const GENERIC_PERSONA_ROLE_TERMS = new Set([
  "師傅",
  "师傅",
  "老師",
  "老师",
  "教師",
  "教师",
  "醫生",
  "医生",
  "達人",
  "达人",
  "博主",
  "店長",
  "店长",
  "先生",
  "小姐",
  "秘書",
  "秘书",
]);

const WEAK_RELEVANCE_STOPWORDS = new Set([
  "未來",
  "未来",
  "風格",
  "风格",
  "黑色",
  "白色",
  "視覺",
  "视觉",
  "呈現",
  "呈现",
  "內容",
  "内容",
  "故事",
  "日常",
  "生活",
  "分享",
  "心得",
  "討論",
  "讨论",
  "推薦",
  "推荐",
  "台灣",
  "台湾",
  "熱門",
  "热门",
  "直播",
  "角色",
  "分析",
]);

["規劃", "规划", "人生", "方向", "海外", "華人", "华人"].forEach((keyword) => WEAK_RELEVANCE_STOPWORDS.add(keyword));
[
  ...SENTIMENT_HOT_GENERIC_QUERY_INTENTS,
  "经验",
  "懒人包",
  "申请",
  "比较",
  "风险",
].forEach((keyword) => {
  GENERIC_SENTIMENT_KEYWORDS.add(keyword);
  WEAK_RELEVANCE_STOPWORDS.add(keyword);
});

function isGenericSentimentKeyword(value: string): boolean {
  const key = cleanText(value).toLowerCase();
  return GENERIC_SENTIMENT_KEYWORDS.has(key);
}

function isGenericPersonaRoleTerm(value: unknown): boolean {
  return GENERIC_PERSONA_ROLE_TERMS.has(cleanText(value));
}

function isWeakRelevanceKeyword(value: string): boolean {
  const keyword = cleanText(value);
  const key = keyword.toLowerCase();
  if (!keyword) return true;
  if (WEAK_RELEVANCE_STOPWORDS.has(keyword) || WEAK_RELEVANCE_STOPWORDS.has(key)) return true;
  if (isGenericSentimentKeyword(keyword)) return true;
  return /^(?:日常|生活|分享|心情|今天|最近|話題|话题|熱門|热门|推薦|推荐|女生|男生|故事|內容|内容)$/u.test(keyword);
}

const DYNAMIC_KEYWORD_STOPWORDS = new Set([
  "人設",
  "人设",
  "內容",
  "内容",
  "內容主題",
  "内容主题",
  "風格",
  "风格",
  "視覺傾向",
  "视觉倾向",
  "圖片視覺傾向",
  "图片视觉倾向",
  "推文",
  "文案",
  "生成",
  "圖片",
  "图片",
  "指定",
  "不指定",
  "工作流",
  "角色",
  "設定",
  "设定",
  "目前風格",
  "目前风格",
  "理性務實",
  "理性务实",
  "務實",
  "务实",
]);

const SENTIMENT_KEYWORD_NEGATION_RE = /(?:不做|不要|不是|不碰|避免|排除|禁止|拒絕|拒绝|非|無關|无关).{0,8}$/u;

function meaningfulNeedles(keywords: string[]): string[] {
  return keywords
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 2 && item.length <= 40 && !isGenericSentimentKeyword(item))
    .slice(0, 32);
}

function normalizeDynamicKeyword(value: string, archiveName: string): string {
  return cleanText(value)
    .replace(/^[-_*#\d.、\s]+/g, "")
    .replace(/^(人設|人设|類型|类型|性格|內容|内容|內容領域|内容领域|風格|风格|主題|主题|模式|記憶|记忆)[:：]?/, "")
    .replace(/^(改成|改為|改为|換成|换成|修改成|修改為|修改为|內容以|内容以|以|面向|面對|是一位|是一个|是一個|聚焦|專注|专注|圍繞|围绕)/, "")
    .replace(archiveName ? new RegExp(archiveName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : /$^/, "")
    .replace(/(人設|人设|設定|设定|風格|风格|推文|文案|傾向|倾向|為主|为主)$/g, "")
    .trim();
}

function hasNegatedKeywordContext(source: string, keyword: string): boolean {
  const key = cleanText(keyword);
  if (!key) return false;
  let index = cleanText(source).indexOf(key);
  while (index >= 0) {
    const prefix = source.slice(Math.max(0, index - 16), index);
    if (SENTIMENT_KEYWORD_NEGATION_RE.test(prefix)) return true;
    index = source.indexOf(key, index + key.length);
  }
  return false;
}

function normalizeSentimentSearchKeyword(value: unknown, options?: { archiveName?: string; sourceText?: string }): string {
  const text = normalizeDynamicKeyword(String(value || ""), options?.archiveName || "")
    .replace(/^[@#]+/g, "")
    .trim();
  const key = text.toLowerCase();
  if (!text) return "";
  if (!hasHan(text) && !/^AI$/i.test(text)) return "";
  if (text.length < 2 || text.length > 12) return "";
  if (/[他她我你]|(?:是一名|是一位|自詡|自認|說話|直白|犀利|深耕|前信貸|機構專員|發文語氣|不鏽|不銹|不鑄)/u.test(text)) return "";
  if (/[的為是]$|^(?:是一|一名|一位|他|她|說)/u.test(text)) return "";
  if (DYNAMIC_KEYWORD_STOPWORDS.has(text) || DYNAMIC_KEYWORD_STOPWORDS.has(key)) return "";
  if (WEAK_RELEVANCE_STOPWORDS.has(text) || WEAK_RELEVANCE_STOPWORDS.has(key)) return "";
  if (isGenericSentimentKeyword(text)) return "";
  if (options?.archiveName && text.includes(options.archiveName)) return "";
  if (options?.sourceText && hasNegatedKeywordContext(options.sourceText, text)) return "";
  return text;
}

function isHollowSearchKeyword(value: unknown): boolean {
  const raw = String(value || "").trim();
  const text = cleanText(value).replace(/\s+/g, "");
  // Domain-agnostic: these words are never a searchable object by themselves.
  if (/^(?:便宜|大叔|煙火氣|烟火气|煙火|烟火|買菜|买菜|愛好者|爱好者|經驗|经验|攻略|省錢|省钱|好物|日常|生活|市井|市井生活|氣氛|气氛|購物|购物)$/u.test(text)) return true;
  // Domain-agnostic template tails. Do not list industry objects here.
  if (/(?:真實體驗|真实体验|價格爭議|价格争议|使用經驗|使用经验|前後變化|前后变化|生活場景|生活场景)$/u.test(text)) return true;
  return /\s/.test(raw) && /(?:對比|对比|真實|真实|吐槽|體驗|体验|變化|变化|爭議|争议)$/u.test(text);
}

function isPublicSearchableKeywordLength(value: unknown): boolean {
  const text = cleanText(value);
  if (!text) return false;
  const han = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  if (han === 0) return /[A-Za-z]{2,}/.test(text) && text.length <= 16;
  return han >= 2 && han <= 5;
}

function filterConflictingSearchKeywords(keywords: string[]): string[] {
  const cleaned = [...new Set(keywords.map(cleanText).filter((term) => (
    term
    && isConcreteSearchKeyword(term)
    && !isHollowSearchKeyword(term)
    && !isGenericPersonaContentTopic(term)
  )))];
  const fluffSuffix = /(?:大叔|愛好者|爱好者|經驗|经验|攻略|生活|購物|购物|周邊商品|周边商品)$/u;
  const withoutFluff = cleaned.filter((term) => {
    if (!fluffSuffix.test(term) || term.length <= 4) return true;
    const stem = term.replace(fluffSuffix, "");
    return !cleaned.some((other) => other !== term && (other === stem || other.startsWith(stem)));
  });
  const compact = (value: string) => value.replace(/\s+/g, "");
  const withoutRemix = withoutFluff.filter((term) => {
    const text = compact(term);
    return !withoutFluff.some((left) => {
      const head = compact(left);
      if (!head || head === text || !text.startsWith(head)) return false;
      const rest = text.slice(head.length);
      return withoutFluff.some((right) => compact(right) === rest);
    });
  });
  const redundantRemainder = /^(?:攻略|教程|教學|教学|分享|心得|评测|測評|测评|推荐|推薦|經驗|经验|生活|故事|撿漏|捡漏|買菜|买菜)$/u;
  const isRedundantLongerTerm = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter) || longer.length <= shorter.length) return false;
    const rest = longer.slice(shorter.length);
    return !rest || redundantRemainder.test(rest) || isGenericSentimentKeyword(rest) || isWeakRelevanceKeyword(rest);
  };
  const shortFirst = [...withoutRemix].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const kept: string[] = [];
  for (const term of shortFirst) {
    if (kept.some((existing) => existing !== term && isRedundantLongerTerm(term, existing))) continue;
    const prefix = term.slice(0, Math.min(3, term.length));
    const sameFamily = kept.filter((existing) => existing.startsWith(prefix) && prefix.length >= 3).length;
    if (sameFamily >= 5) continue;
    kept.push(term);
  }
  return withoutRemix.filter((term) => kept.includes(term));
}

function expandSentimentHotCoreKeywordVariants(keywords: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const text = cleanText(value);
    if (!text || !isConcreteSearchKeyword(text)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  const suffixes = [
    "前后对比",
    "前後對比",
    "行业动态",
    "行業動態",
    "真实体验",
    "真實體驗",
    "使用经验",
    "使用經驗",
    "价格争议",
    "價格爭議",
    "避坑",
    "互动",
    "互動",
    "吐槽",
    "痛点",
    "痛點",
    "测评",
    "測評",
    "场景",
    "場景",
    "推荐",
    "推薦",
    "价格",
    "價格",
    "新番",
    "課金",
    "课金",
    "氪金",
    "韭菜",
    "真實",
    "真实",
    "實錄",
    "实录",
    "搞笑",
    "神作",
    "翻車",
    "翻车",
    "失敗",
    "失败",
    "服务",
    "服務",
    "体验",
    "體驗",
    "工具",
    "社区",
    "社群",
    "对象",
    "對象",
    "产品",
    "產品",
    "行业",
    "行業",
    "店",
    "师",
    "師",
  ];
  for (const keyword of keywords) {
    const text = cleanText(keyword);
    add(text);
    if (!text || !hasHan(text)) continue;
    if (/头发/u.test(text)) add(text.replace(/头发/gu, "发"));
    // A model query can contain more than one discovery intent, such as
    // "动漫新番吐槽" or "游戏课金避坑".  Strip those suffixes iteratively
    // so the public crawler gets the stable subject ("动漫" / "游戏") in its
    // small first query batch.  The candidate still has to pass the existing
    // Chinese, relevance and >=500 heat gates below.
    let topic = text;
    for (let depth = 0; depth < 3; depth += 1) {
      const suffix = suffixes.find((item) => topic.length > item.length + 1 && topic.endsWith(item));
      if (!suffix) break;
      topic = topic.slice(0, -suffix.length);
      add(topic);
    }
  }
  return out;
}

function rankSearchKeywords(keywords: string[]): string[] {
  return keywords
    .map((keyword, index) => {
      let score = 0;
      if (!isWeakRelevanceKeyword(keyword)) score += 30;
      if (keyword.length === 2) score += 40;
      else if (keyword.length === 3) score += 35;
      else if (keyword.length === 4) score += 20;
      else if (keyword.length === 5) score += 8;
      if (keyword.length > 5) score -= 15;
      if (keyword.length > 8) score -= 25;
      return { keyword, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.keyword);
}

function isConcreteSearchKeyword(value: unknown): boolean {
  const keyword = cleanText(value);
  // A persona can target a global Threads topic with a concrete Latin term
  // (for example a product, occupation, or tag).  Reject phrases that have no
  // searchable letters, but do not silently discard those terms before the
  // public-page query is made.
  const hasSearchLetters = hasHan(keyword) || /[a-z]/i.test(keyword);
  if (!keyword || !hasSearchLetters) return false;
  if (keyword.length < 2 || keyword.length > 32) return false;
  if (/\s/.test(keyword)) return false;
  // Discovery intents are useful only when attached to a persona-domain
  // subject. Bare intent words drift into unrelated high-traffic topics.
  if (/韭菜/u.test(keyword)) return false;
  if (/^(?:價格|价格|真實|真实|搞笑|吐槽|避坑|踩雷|翻車|翻车|推薦|推荐|測評|测评|體驗|体验|互動|互动|對比|对比)$/u.test(keyword)) return false;
  if (isWeakRelevanceKeyword(keyword) || isGenericSentimentKeyword(keyword)) return false;
  if (/[()[\]{}]|(?:^|[^\d])\d{2,}(?:公分|cm|CM)?/u.test(keyword)) return false;
  if (/(?:幽默|接地氣|接地气|宅氣|宅气|善良|智慧|愛心|爱心|溫柔|温柔|鼓勵|鼓励|耐心|致力|充滿|充满|治癒感|疗愈感|自律感|反差魅力|視覺|视觉|傾向|倾向)/u.test(keyword)) return false;
  if (/(?:自詡|自诩|自認|自认|說話|说话|語氣|语气|風格|风格|傾向|倾向|日常|熱門|热门|分享|穿著|穿着|身高|公分|老公|老婆|女孩|男孩|男人|女人|美女圖|美女图|身份|身分|領域|领域|語氣|语气|視覺|视觉|邊界|边界|沉穩|沉稳|高雅|親和|亲和)/u.test(keyword)) return false;
  if (/(?:的|在|裡|里|和|以及|可以|能夠|能够|充滿|充满)$/u.test(keyword)) return false;
  return true;
}

function normalizeSentimentHotSearchMode(value: unknown): SentimentHotSearchMode {
  return String(value || "").trim().toLowerCase() === "normal" ? "normal" : "strict";
}

export function normalizeSentimentHotFreshnessDays(value: unknown): number {
  const days = Math.round(Number(value));
  return Number.isFinite(days) ? Math.min(30, Math.max(0, days)) : 0;
}

export function candidateMatchesRequestedFreshness(candidate: SentimentHotCandidate, value: unknown): boolean {
  const freshnessDays = normalizeSentimentHotFreshnessDays(value);
  return freshnessDays <= 0 || candidateHasAcceptableFreshness(candidate, freshnessDays);
}

function candidateMatchesOperationalFreshness(candidate: SentimentHotCandidate, value: unknown): boolean {
  const freshnessDays = normalizeSentimentHotFreshnessDays(value);
  return freshnessDays <= 0 || candidateMatchesRequestedFreshness(candidate, freshnessDays);
}

function sentimentHotKeywordTargetForMode(mode: SentimentHotSearchMode): number {
  return mode === "normal" ? SENTIMENT_HOT_NORMAL_KEYWORD_TARGET : SENTIMENT_HOT_STRICT_KEYWORD_TARGET;
}

function prepareSentimentHotKeywordsForMode(keywords: string[], mode: SentimentHotSearchMode): string[] {
  const normalized = filterConflictingSearchKeywords([...new Set(
    expandSentimentHotCoreKeywordVariants(keywords).map(cleanText).filter((item) => isConcreteSearchKeyword(item)),
  )]);
  const searchable = normalized.filter((item) => isPublicSearchableKeywordLength(item));
  return rankSearchKeywords(searchable.length ? searchable : normalized).slice(0, sentimentHotKeywordTargetForMode(mode));
}

const PERSONA_APPEARANCE_PROMPT_NOISE = /(?:[闷悶]骚|网上开车|網上開車|爆奶|性感身材|秃顶|禿頂|黑框眼镜|黑框眼鏡)/u;

function splitPersonaThemeAndVisual(value: unknown): { theme: string; visual: string } {
  const raw = cleanText(value);
  if (!raw) return { theme: "", visual: "" };
  const parts = raw.split(/视觉倾向|視覺傾向|图片视觉|圖片視覺|核心走向/u);
  let theme = cleanText(parts[0] || "");
  let visual = cleanText(parts.slice(1).join(" "));
  if (PERSONA_APPEARANCE_PROMPT_NOISE.test(theme)) {
    visual = [theme, visual].filter(Boolean).join("；");
    theme = "";
  }
  return { theme, visual };
}

export function personaHotStrategyDisplayName(value: unknown): string {
  const name = cleanText(value);
  if (!name) return "";
  // Slang nicknames are kept on the persona card, but sending them to the
  // keyword model often yields an empty candidate list (safety / gateway).
  if (/老司机|老司機|老濕|老湿|色女|[闷悶]骚/u.test(name)) {
    return "按下方职业与内容领域理解的人设";
  }
  return name;
}

function personaHotStrategySourceText(archive: Partial<Pick<PersonaArchive, "name" | "content" | "setup">> | undefined): string {
  const setup = (archive?.setup || {}) as Record<string, any>;
  const list = (value: unknown) => Array.isArray(value)
    ? value.map(cleanText).filter((item) => item && !PERSONA_APPEARANCE_PROMPT_NOISE.test(item))
    : [];
  const theme = splitPersonaThemeAndVisual(setup.contentTheme);
  const custom = splitPersonaThemeAndVisual(setup.customTopic);
  const description = splitPersonaThemeAndVisual(setup.personaDescription);
  const content = splitPersonaThemeAndVisual(archive?.content);
  const displayName = personaHotStrategyDisplayName(archive?.name);
  return [
    displayName ? `人设名称：${displayName}` : "",
    list(setup.genres).length ? `内容领域：${list(setup.genres).join("、")}` : "",
    list(setup.interests).length ? `兴趣标签：${list(setup.interests).join("、")}` : "",
    theme.theme ? `内容主题：${theme.theme}` : "",
    custom.theme ? `人设主题：${custom.theme}` : "",
    description.theme ? `人设简介：${description.theme.slice(0, 400)}` : "",
    content.theme ? `人设说明：${content.theme.slice(0, 400)}` : "",
    list(setup.trendTopics).length ? `平台标签关键词：${list(setup.trendTopics).join("、")}` : "",
  ].filter(Boolean).join("\n");
}

function emptySentimentHotSearchStrategy(): SentimentHotSearchStrategy {
  return {
    primaryQueries: [],
    broadQueries: [],
    ecosystemQueries: [],
    requiredAnchorTerms: [],
    normalAnchorTerms: [],
    strictAcceptTerms: [],
    normalAcceptTerms: [],
    rejectTerms: [],
  };
}

function isPersonaVisualArtifactKeyword(keyword: string, sourceText: string): boolean {
  const term = cleanText(keyword);
  if (!term) return false;
  const source = cleanText(sourceText);
  const domainAllowsStylingTerms = /(?:服裝|服装|穿搭|時尚|时尚|潮牌|攝影|摄影|模特|美妝|美妆|造型師|造型师|美髮|美发|髮型|发型|理髮|理发|美容)/u.test(source);
  if (domainAllowsStylingTerms && /^(?:穿搭|造型師|造型师|髮型|发型|妝容|妆容|服裝|服装)$/u.test(term)) return false;
  if (/^(?:造型|頭髮|头发)$/u.test(term)) return true;
  return /(?:緊身|紧身|黑T|白T|T恤|襯衫|衬衫|西裝|西装|外套|牛仔褲|牛仔裤|眼鏡|眼镜|啤酒|茶杯|杯子|拿著|拿着|站姿|坐姿|身高|體型|体型|背景|照片|圖片|图片|頭像|头像|外貌|服飾|服饰|穿著|穿着|視覺|视觉|道具|圍裙|围裙|棉麻|口哨|工裝|工装)/u.test(term);
}

function normalizeStrategyTermList(value: unknown, args: { archiveName?: string; sourceText: string; limit: number }): string[] {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw
    .map((item) => cleanText(String(item || "")).replace(/^[@#]+/g, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 18 && !/\s/.test(item) && (hasHan(item) || /[A-Za-z]{2,}/.test(item)))
  )].slice(0, args.limit);
}

function normalizeStrategyAnchorTermList(value: unknown, args: { archiveName?: string; sourceText: string; limit: number }): string[] {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw
    .map((item) => normalizeSentimentSearchKeyword(item, { archiveName: args.archiveName, sourceText: args.sourceText }))
    .filter((item) => item.length <= 14 && isSearchableRelevanceTerm(item) && !isPersonaVisualArtifactKeyword(item, args.sourceText))
  )].slice(0, args.limit);
}

function isGenericPersonaContentTopic(value: unknown): boolean {
  const text = cleanText(value).replace(/\s+/g, "");
  return /^(?:职场趣事|職場趣事|生活日常|日常生活|生活故事|生活分享|市井生活|市井|職場故事|职场故事|搞笑|幽默|趣事|故事|经验|經驗|分享|日常|慢生活|退休生活|健康生活|家務|家务|家居清潔|家居清洁|居家清潔|居家清洁)$/u.test(text);
}

function filterModelQueriesByDomainAnchors(queries: string[], anchors: string[]): string[] {
  const domainAnchors = anchors.map(cleanText).filter((anchor) => anchor && !isGenericPersonaContentTopic(anchor));
  const cleanQueries = queries.map(cleanText).filter(Boolean);
  // A brand-new persona often only yields visual/lifestyle anchors, which are
  // dropped. Keep the model's own object nouns instead of wiping the strategy.
  if (domainAnchors.length === 0) return cleanQueries;
  const matched = cleanQueries.filter((query) => domainAnchors.some((anchor) => (
    query.includes(anchor) || (anchor.length >= 2 && anchor.includes(query))
  )));
  if (matched.length >= 5) return matched;
  // Parent anchors like 汽車維修 would otherwise delete 機油/剎車片 and leave
  // primaryQueries empty even though the model already stayed in-domain.
  const objectNouns = cleanQueries.filter((query) => (
    isPublicSearchableKeywordLength(query)
    && query.length <= 4
    && !isGenericPersonaContentTopic(query)
  ));
  return [...new Set([...matched, ...objectNouns])];
}

function modelObjectNounsFromStrategy(strategy: SentimentHotSearchStrategy): string[] {
  return [...new Set([
    ...strategy.primaryQueries,
    ...strategy.broadQueries,
    ...strategy.ecosystemQueries,
  ]
    .map(cleanText)
    .filter((term) => (
      isConcreteSearchKeyword(term)
      && isPublicSearchableKeywordLength(term)
      && term.length <= 4
      && !isGenericPersonaContentTopic(term)
      && !isPersonaVisualArtifactKeyword(term, "")
    )))];
}

function retainModelObjectNounsWhenAnchorsVanish(strategy: SentimentHotSearchStrategy) {
  const objectNouns = modelObjectNounsFromStrategy(strategy);
  if (!objectNouns.length) return;
  if (strategy.requiredAnchorTerms.length < 3) {
    strategy.requiredAnchorTerms = [...new Set([...strategy.requiredAnchorTerms, ...objectNouns])].slice(0, 16);
  }
  if (strategy.normalAnchorTerms.length < 3) {
    strategy.normalAnchorTerms = [...new Set([...strategy.normalAnchorTerms, ...objectNouns])].slice(0, 16);
  }
  if (strategy.strictAcceptTerms.length < 5) {
    strategy.strictAcceptTerms = [...new Set([...strategy.strictAcceptTerms, ...strategy.primaryQueries, ...objectNouns])].slice(0, SENTIMENT_MODEL_KEYWORD_TARGET);
  }
  if (strategy.normalAcceptTerms.length < 5) {
    strategy.normalAcceptTerms = [...new Set([...strategy.normalAcceptTerms, ...strategy.primaryQueries, ...strategy.broadQueries, ...objectNouns])].slice(0, SENTIMENT_HOT_NORMAL_KEYWORD_TARGET);
  }
  if (strategy.primaryQueries.length < 5) {
    const refill = [...strategy.requiredAnchorTerms, ...strategy.strictAcceptTerms]
      .map(cleanText)
      .filter((term) => isPublicSearchableKeywordLength(term) && term.length <= 5 && !isGenericPersonaContentTopic(term));
    strategy.primaryQueries = [...new Set([...strategy.primaryQueries, ...objectNouns, ...refill])].slice(0, SENTIMENT_MODEL_KEYWORD_TARGET);
  }
}

function parseModelJsonObject(text: string): any {
  const raw = cleanText(text).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = safeJson(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length) return parsed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const embedded = safeJson(raw.slice(start, end + 1));
    if (embedded && typeof embedded === "object" && !Array.isArray(embedded) && Object.keys(embedded).length) return embedded;
  }
  return undefined;
}

function parseSentimentHotSearchStrategy(text: string, args: { archiveName?: string; sourceText: string }): SentimentHotSearchStrategy {
  const parsed = parseModelJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptySentimentHotSearchStrategy();
  }
  const primaryQueries = normalizeStrategyTermList((parsed as any).primaryQueries || (parsed as any).queries || (parsed as any).keywords, { ...args, limit: SENTIMENT_MODEL_KEYWORD_TARGET });
  const broadQueries = normalizeStrategyTermList((parsed as any).broadQueries || (parsed as any).domainExpansion || (parsed as any).normalQueries || (parsed as any).expandedQueries || primaryQueries, { ...args, limit: SENTIMENT_HOT_NORMAL_KEYWORD_TARGET });
  const requiredAnchorTerms = normalizeStrategyAnchorTermList(
    (parsed as any).requiredAnchorTerms || (parsed as any).anchorTerms || (parsed as any).coreEntityTerms || primaryQueries.slice(0, 4),
    { ...args, limit: 16 },
  ).filter((term) => !isGenericPersonaContentTopic(term));
  const normalAnchorTerms = normalizeStrategyAnchorTermList(
    (parsed as any).normalAnchorTerms || (parsed as any).parentAnchorTerms || requiredAnchorTerms || primaryQueries.slice(0, 4),
    { ...args, limit: 16 },
  ).filter((term) => !isGenericPersonaContentTopic(term));
  const domainAnchors = [...new Set([...requiredAnchorTerms, ...normalAnchorTerms])];
  const strategy: SentimentHotSearchStrategy = {
    primaryQueries,
    broadQueries: filterModelQueriesByDomainAnchors(broadQueries, domainAnchors),
    ecosystemQueries: filterModelQueriesByDomainAnchors(
      normalizeStrategyTermList((parsed as any).ecosystemQueries || (parsed as any).parentQueries || (parsed as any).highVolumeQueries || broadQueries, { ...args, limit: SENTIMENT_HOT_NORMAL_KEYWORD_TARGET }),
      domainAnchors,
    ),
    requiredAnchorTerms,
    normalAnchorTerms,
    strictAcceptTerms: normalizeStrategyTermList((parsed as any).strictAcceptTerms || (parsed as any).strictTerms || (parsed as any).acceptTerms || [...requiredAnchorTerms, ...primaryQueries], { ...args, limit: SENTIMENT_MODEL_KEYWORD_TARGET }),
    normalAcceptTerms: normalizeStrategyTermList((parsed as any).normalAcceptTerms || (parsed as any).broadAcceptTerms || [...normalAnchorTerms, ...primaryQueries, ...broadQueries], { ...args, limit: SENTIMENT_HOT_NORMAL_KEYWORD_TARGET }),
    rejectTerms: normalizeStrategyTermList((parsed as any).rejectTerms || (parsed as any).excludeTerms || (parsed as any).negativeTerms, { ...args, limit: 16 }),
    domainSummary: cleanText((parsed as any).domainSummary || (parsed as any).summary),
  };
  if (strategy.requiredAnchorTerms.length < 3) {
    strategy.requiredAnchorTerms = primaryQueries.slice(0, 4);
  }
  if (strategy.normalAnchorTerms.length < 3) {
    strategy.normalAnchorTerms = primaryQueries.slice(0, 4);
  }
  retainModelObjectNounsWhenAnchorsVanish(strategy);
  return strategy;
}

function sentimentHotStrategyHasModelTerms(strategy: SentimentHotSearchStrategy): boolean {
  return Array.isArray(strategy.primaryQueries) && strategy.primaryQueries.length >= 5
    && Array.isArray(strategy.requiredAnchorTerms) && strategy.requiredAnchorTerms.length >= 3
    && Array.isArray(strategy.normalAnchorTerms) && strategy.normalAnchorTerms.length >= 3
    && strategy.normalAnchorTerms.filter((term) => term.length >= 2).length >= 2
    && Array.isArray(strategy.strictAcceptTerms) && strategy.strictAcceptTerms.length >= 5
    && Array.isArray(strategy.normalAcceptTerms) && strategy.normalAcceptTerms.length >= 5
    && Boolean(cleanText(strategy.domainSummary));
}

function sentimentHotStrategyUsesThreadsChinese(strategy: SentimentHotSearchStrategy): boolean {
  const text = [
    ...strategy.primaryQueries,
    ...strategy.broadQueries,
    ...strategy.ecosystemQueries,
    ...strategy.requiredAnchorTerms,
    ...strategy.normalAnchorTerms,
    ...strategy.strictAcceptTerms,
    ...strategy.normalAcceptTerms,
  ].join("");
  return (text.match(/[\u3400-\u9fff]/gu) || []).length >= 16;
}

function sentimentHotStrategyTermsForMode(strategy: SentimentHotSearchStrategy, mode: SentimentHotSearchMode): string[] {
  const groups = mode === "normal"
    ? [strategy.primaryQueries, strategy.ecosystemQueries, strategy.broadQueries, strategy.normalAnchorTerms, strategy.normalAcceptTerms, strategy.strictAcceptTerms]
    : [strategy.primaryQueries, strategy.requiredAnchorTerms, strategy.strictAcceptTerms];
  const terms: string[] = [];
  for (let index = 0; index < Math.max(0, ...groups.map((group) => group.length)); index += 1) {
    for (const group of groups) {
      const term = cleanText(group[index]);
      if (term) terms.push(term);
    }
  }
  return [...new Set(terms)];
}

function sentimentHotModelDispatchTermsForMode(strategy: SentimentHotSearchStrategy, mode: SentimentHotSearchMode): string[] {
  const groups = mode === "normal"
    ? [strategy.primaryQueries, strategy.ecosystemQueries, strategy.broadQueries]
    : [
        strategy.primaryQueries,
        strategy.requiredAnchorTerms.filter((term) => cleanText(term).length >= 2),
        strategy.normalAnchorTerms.filter((term) => cleanText(term).length >= 2),
      ];
  const target = sentimentHotKeywordTargetForMode(mode);
  const terms: string[] = [];
  for (const group of groups) {
    for (const item of group) {
      const term = cleanText(item);
      if (!term || !isConcreteSearchKeyword(term)) continue;
      if (!terms.some((existing) => existing.toLowerCase() === term.toLowerCase())) terms.push(term);
    }
  }
  const filtered = filterConflictingSearchKeywords(terms);
  const searchable = filtered.filter((item) => isPublicSearchableKeywordLength(item));
  return (searchable.length ? searchable : filtered).slice(0, target);
}

export function resolveSentimentHotModelStrategyKeywords(
  strategy: SentimentHotSearchStrategy | null | undefined,
  mode: SentimentHotSearchMode,
): string[] {
  if (!strategy) return [];
  const primary = [...new Set((strategy.primaryQueries || []).map(cleanText).filter(Boolean))];
  if (primary.length < 5) {
    if (!sentimentHotStrategyHasModelTerms(strategy)) return [];
    return sentimentHotModelDispatchTermsForMode(strategy, mode);
  }
  const expansion = [...new Set([
    ...(strategy.broadQueries || []),
    ...(strategy.ecosystemQueries || []),
  ]
    .map(cleanText)
    .filter((term) => (
      term
      && isConcreteSearchKeyword(term)
      && isPublicSearchableKeywordLength(term)
      && term.length <= 5
      && !isGenericPersonaContentTopic(term)
      && !isPersonaVisualArtifactKeyword(term, "")
      && !/(?:攻略|教程|教學|教学|分享|心得|评测|測評|测评|推荐|推薦|經驗|经验)$/u.test(term)
    )))];
  const merged = [...primary];
  for (const term of expansion) {
    if (!merged.some((item) => item.toLowerCase() === term.toLowerCase())) merged.push(term);
  }
  return merged.slice(0, sentimentHotKeywordTargetForMode(mode));
}

export function resolveSentimentHotModelQueryKeywords(
  strategy: SentimentHotSearchStrategy | null | undefined,
  mode: SentimentHotSearchMode,
): string[] {
  if (!strategy || !sentimentHotStrategyHasModelTerms(strategy)) return [];
  if (mode === "strict") {
    const anchors = filterConflictingSearchKeywords([...new Set([
      ...strategy.requiredAnchorTerms,
      ...strategy.normalAnchorTerms,
    ].flatMap((item) => expandSentimentHotCoreKeywordVariants([item])).map(cleanText).filter((item) => isConcreteSearchKeyword(item)))]);
    const broadAnchors = prepareSentimentHotKeywordsForMode([
      ...strategy.broadQueries,
      ...strategy.ecosystemQueries,
    ], "normal");
    const rest = prepareSentimentHotKeywordsForMode([
      ...strategy.primaryQueries,
      ...strategy.strictAcceptTerms,
      ...strategy.normalAcceptTerms,
    ], "normal");
    return [...new Set([...anchors, ...broadAnchors, ...rest])].slice(0, SENTIMENT_HOT_NORMAL_KEYWORD_TARGET);
  }
  // Strict mode keeps its acceptance filter narrow, but discovery also needs
  // the model's broad vertical queries. The final quality/anchor checks still
  // reject posts that do not match the strict persona keywords.
  return prepareSentimentHotKeywordsForMode(sentimentHotStrategyTermsForMode(strategy, mode), mode);
}

export function resolveSentimentHotManualQueryKeywords(
  manualKeywords: string[],
  _strategy: SentimentHotSearchStrategy | null | undefined,
  mode: SentimentHotSearchMode,
): string[] {
  const explicitManualKeywords = [...new Set(
    manualKeywords.map(cleanText).filter((item) => (
      isConcreteSearchKeyword(item)
      && !isHollowSearchKeyword(item)
      && !isGenericPersonaContentTopic(item)
      && !isPersonaVisualArtifactKeyword(item, "")
    )),
  )];
  const fluffSuffix = /(?:大叔|愛好者|爱好者|經驗|经验|攻略|生活)$/u;
  const withoutFluff = explicitManualKeywords.filter((term) => {
    if (!fluffSuffix.test(term) || term.length <= 4) return true;
    const stem = term.replace(fluffSuffix, "");
    return !explicitManualKeywords.some((other) => other !== term && (other === stem || other.startsWith(stem)));
  });
  const compact = (value: string) => value.replace(/\s+/g, "");
  const withoutRemix = withoutFluff.filter((term) => {
    const text = compact(term);
    return !withoutFluff.some((left) => {
      const head = compact(left);
      if (!head || head === text || !text.startsWith(head)) return false;
      const rest = text.slice(head.length);
      return withoutFluff.some((right) => compact(right) === rest);
    });
  });
  const fromStrategy = _strategy
    ? resolveSentimentHotModelQueryKeywords(_strategy, mode).filter((term) => !withoutRemix.includes(term))
    : [];
  // Keep the model's own terms. Do not invent shorter substitutes in code.
  const merged = filterConflictingSearchKeywords([...withoutRemix, ...fromStrategy]);
  const searchable = merged.filter((item) => isPublicSearchableKeywordLength(item));
  return (searchable.length ? searchable : merged).slice(0, sentimentHotKeywordTargetForMode(mode));
}

function splitAnchorMashupTerms(terms: string[], anchors: string[]): string[] {
  const compactAnchors = [...new Set(anchors.map((item) => item.replace(/\s+/g, "")).filter((item) => item.length >= 2))];
  const out: string[] = [];
  for (const term of terms) {
    const text = String(term || "").replace(/\s+/g, "");
    const pair = compactAnchors.find((left) => {
      if (!text.startsWith(left) || text === left) return false;
      return compactAnchors.includes(text.slice(left.length));
    });
    if (!pair) {
      out.push(term);
      continue;
    }
    out.push(pair, text.slice(pair.length));
  }
  return [...new Set(out.map(cleanText).filter(Boolean))];
}

export function applyPersonaGuardToSentimentHotStrategy(args: {
  strategy: SentimentHotSearchStrategy;
}) {
  const cleanModelTerms = (terms: string[]) => [...new Set(
    terms
      .map((term) => normalizeSentimentSearchKeyword(term))
      .filter((term) => (
        isConcreteSearchKeyword(term)
        && !isGenericPersonaRoleTerm(term)
        && !isHollowSearchKeyword(term)
        && !isGenericPersonaContentTopic(term)
        && !isPersonaVisualArtifactKeyword(term, "")
      )),
  )];
  args.strategy.requiredAnchorTerms = cleanModelTerms(args.strategy.requiredAnchorTerms).filter((term) => !isGenericPersonaContentTopic(term));
  args.strategy.normalAnchorTerms = cleanModelTerms(args.strategy.normalAnchorTerms).filter((term) => !isGenericPersonaContentTopic(term));
  const domainAnchors = [...new Set([...args.strategy.requiredAnchorTerms, ...args.strategy.normalAnchorTerms])];
  args.strategy.primaryQueries = filterModelQueriesByDomainAnchors(
    cleanModelTerms(splitAnchorMashupTerms(args.strategy.primaryQueries, domainAnchors)),
    domainAnchors,
  );
  args.strategy.broadQueries = filterModelQueriesByDomainAnchors(
    cleanModelTerms(splitAnchorMashupTerms(args.strategy.broadQueries, domainAnchors)),
    domainAnchors,
  );
  args.strategy.ecosystemQueries = filterModelQueriesByDomainAnchors(
    cleanModelTerms(splitAnchorMashupTerms(args.strategy.ecosystemQueries, domainAnchors)),
    domainAnchors,
  );
  args.strategy.strictAcceptTerms = cleanModelTerms(splitAnchorMashupTerms(args.strategy.strictAcceptTerms, domainAnchors));
  args.strategy.normalAcceptTerms = cleanModelTerms(splitAnchorMashupTerms(args.strategy.normalAcceptTerms, domainAnchors));
  args.strategy.rejectTerms = cleanModelTerms(args.strategy.rejectTerms);
  retainModelObjectNounsWhenAnchorsVanish(args.strategy);
  args.strategy.personaGuardTerms = [...new Set([
    ...args.strategy.normalAnchorTerms,
    ...args.strategy.requiredAnchorTerms,
  ])].slice(0, 6);
}

export function candidateMatchesSentimentHotStrategyAnchors(candidate: SentimentHotCandidate, strategy: SentimentHotSearchStrategy, mode: SentimentHotSearchMode): boolean {
  const matchesExactAnchor = (anchor: string, target: SentimentHotCandidate = candidate) => {
    const fullVariants = [...new Set([anchor, ...expandSentimentSearchKeywordVariants(anchor)].map(cleanText).filter(Boolean))];
    return countMatchedNeedles(target, fullVariants) > 0;
  };
  const matchesLeadingAnchor = (anchor: string) => {
    const content = cleanSentimentCandidateContent(candidate.content);
    const leadingLength = Math.max(120, Math.ceil(content.length * 0.45));
    return matchesExactAnchor(anchor, { ...candidate, content: content.slice(0, leadingLength) });
  };
  const rejectTerms = strategy.rejectTerms.map(cleanText).filter((term) => term.length >= 2);
  if (rejectTerms.some((term) => countMatchedNeedles(candidate, [term]) > 0)) return false;
  if ((candidate.metrics as any)?.globalPersonaBackfill === true) {
    const sourceQuery = cleanText((candidate.metrics as any)?.query);
    const currentQueries = expandSentimentHotCoreKeywordVariants(sentimentHotStrategyTermsForMode(strategy, mode))
      .flatMap((term) => [term, ...expandSentimentSearchKeywordVariants(term)])
      .map(cleanText)
      .filter((term) => term.length >= 2);
    const belongsToCurrentStrategy = sourceQuery.length >= 2 && currentQueries.some((term) => (
      sourceQuery === term
      || (sourceQuery.length >= 3 && term.includes(sourceQuery))
      || (term.length >= 3 && sourceQuery.includes(term))
    ));
    if (!belongsToCurrentStrategy) {
      // A global candidate may have been discovered by another persona/query.
      // Reuse it only when the article itself carries at least two concrete
      // current-domain anchors; one incidental mention is still rejected.
      const directMatches = [...new Set(currentQueries)]
        .filter((term) => term.length >= 3 && isConcreteSearchKeyword(term))
        .filter((term) => matchesExactAnchor(term));
      if (directMatches.length < 2) return false;
    }
  }
  const requiredAnchors = expandSentimentHotCoreKeywordVariants(strategy.requiredAnchorTerms).filter((term) => term.length >= 2);
  const normalAnchors = expandSentimentHotCoreKeywordVariants(strategy.normalAnchorTerms).filter((term) => term.length >= 2);
  const sourceQuery = cleanText((candidate.metrics as any)?.query);
  const currentStrategyTerms = new Set(expandSentimentHotCoreKeywordVariants(sentimentHotStrategyTermsForMode(strategy, "normal")).map(cleanText));
  if (sourceQuery && sourceQuery.length <= 3 && !currentStrategyTerms.has(sourceQuery) && normalAnchors[0]) {
    const leadingContent = cleanSentimentCandidateContent(candidate.content).slice(0, 120);
    if (!matchesExactAnchor(normalAnchors[0], { ...candidate, content: leadingContent })) return false;
  }
  const personaGuardTerms = (strategy.personaGuardTerms || []).map(cleanText).filter((term) => term.length >= 2);
  if (mode === "normal") {
    const personaGuardKeys = new Set(personaGuardTerms.map((term) => term.toLowerCase()));
    const domainNormalAnchors = normalAnchors.filter((term) => !personaGuardKeys.has(term.toLowerCase()));
    if (domainNormalAnchors.some(matchesLeadingAnchor)) return true;
    const normalAcceptTerms = strategy.normalAcceptTerms
      .map(cleanText)
      .filter((term) => term.length >= 2 && !personaGuardKeys.has(term.toLowerCase()));
    return [...new Set([...requiredAnchors, ...domainNormalAnchors, ...normalAcceptTerms])]
      .filter(matchesLeadingAnchor).length >= 2;
  }
  // A role-like persona name (for example "secretary") is not evidence that
  // the post belongs to the persona's actual domain. One model-selected direct
  // domain anchor is stronger and keeps niche searches from requiring two
  // different topic words in every valid post.
  const directPrimaryAnchors = [...strategy.primaryQueries, ...strategy.strictAcceptTerms]
    .flatMap((term) => expandSentimentHotCoreKeywordVariants([term]))
    .map(cleanText)
    .filter((term) => term.length >= 3 && isConcreteSearchKeyword(term));
  return [...new Set([...requiredAnchors, ...directPrimaryAnchors])]
    .some((anchor) => matchesExactAnchor(anchor));
}

function candidateMatchesStrategyOrVerifiedFreshFallback(
  candidate: SentimentHotCandidate,
  strategy: SentimentHotSearchStrategy,
  mode: SentimentHotSearchMode,
): boolean {
  if (!candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, mode)) return false;
  return true;
}

function parseSentimentHotSemanticDecision(value: unknown): { acceptedIds?: string[]; rejectedIds?: string[] } | null {
  const raw = cleanText(value).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const acceptedIds = Array.isArray(parsed.acceptedIds)
      ? [...new Set(parsed.acceptedIds.map((id: unknown) => cleanText(id)).filter(Boolean))]
      : undefined;
    const rejectedIds = Array.isArray(parsed.rejectedIds)
      ? [...new Set(parsed.rejectedIds.map((id: unknown) => cleanText(id)).filter(Boolean))]
      : undefined;
    if (!acceptedIds && !rejectedIds) return null;
    return { acceptedIds, rejectedIds };
  } catch {
    return null;
  }
}

function parseSentimentHotSemanticAcceptedIds(value: unknown): string[] | null {
  const decision = parseSentimentHotSemanticDecision(value);
  if (!decision) return null;
  return decision.acceptedIds || [];
}

async function filterSentimentHotCandidatesWithModel(args: {
  archive?: PersonaArchive;
  strategy: SentimentHotSearchStrategy;
  keywords: string[];
  searchMode: SentimentHotSearchMode;
  limit: number;
  candidates: SentimentHotCandidate[];
  warnings: string[];
  timeoutMs?: number;
  allowRecovery?: boolean;
}): Promise<{ accepted: SentimentHotCandidate[]; tagged: SentimentHotCandidate[]; scope?: string }> {
  if (!args.archive || args.candidates.length === 0) {
    return { accepted: args.candidates, tagged: args.candidates };
  }
  const scope = crypto.createHash("sha1").update(JSON.stringify({
    version: SENTIMENT_HOT_SEMANTIC_RELEVANCE_VERSION,
    archiveId: args.archive.id,
    mode: args.searchMode,
    domain: args.strategy.domainSummary,
    persona: cleanText(args.archive.content),
    keywords: args.keywords,
  })).digest("hex");
  const contentHash = (candidate: SentimentHotCandidate) => crypto.createHash("sha1").update(cleanSentimentCandidateContent(candidate.content)).digest("hex");
  const known = args.candidates.filter((candidate) => {
    const metrics = candidate.metrics as any;
    return metrics?.semanticRelevanceScope === scope
      && metrics?.semanticContentHash === contentHash(candidate)
      && typeof metrics?.semanticRelevant === "boolean";
  });
  const unknown = args.candidates.filter((candidate) => !known.includes(candidate)).slice(0, 30);
  if (unknown.length === 0) {
    return { accepted: known.filter((candidate) => (candidate.metrics as any)?.semanticRelevant === true), tagged: args.candidates, scope };
  }
  try {
    const candidateAliases = new Map<string, string>();
    const candidatePayload = unknown.map((candidate, index) => {
      const alias = `c${index + 1}`;
      candidateAliases.set(alias, candidate.id);
      return {
      id: alias,
      content: cleanSentimentCandidateContent(candidate.content).slice(0, 1200),
      matchedTerms: Array.isArray((candidate.metrics as any)?.matchedKeywords)
        ? (candidate.metrics as any).matchedKeywords.slice(0, 5)
        : [],
      searchQuery: cleanText((candidate.metrics as any)?.query).slice(0, 50),
      };
    });
    const result = await callTextUnderstandingModelWithFallback(
      resolveSentimentHotTextModelPreference(),
      [{ role: "user", parts: [{ text: [
        "You review social hotspot candidates. Return JSON only: {\"rejectedIds\":[\"candidate alias\"]}.",
        `Full persona profile: ${cleanText(args.archive.content)}`,
        `Review mode: ${args.searchMode}. Start from every candidate and reject reverse or unrelated posts first. Do not first pick only strongly positive topical matches.`,
        "Reject only reverse stance, same-name false hits, or content completely outside the persona. Keep weak or adjacent matches.",
        `Candidates: ${JSON.stringify(candidatePayload)}`,
        "你是社媒热点候选的语义审核器。只输出 JSON，不要解释，不要 Markdown。",
        "输出格式：{\"rejectedIds\":[\"候选ID\"]}",
        `人设主领域：${args.strategy.domainSummary || cleanText(args.archive.content)}`,
        `明确排除范围：${args.strategy.rejectTerms.join("、") || "无"}`,
        `抓取模式：${args.searchMode === "strict" ? "严格垂直" : "普通泛垂直"}`,
        "优先排除反向内容、明显垃圾和无用推文、以及完全不相干的内容，而不是先挑选正向命中。",
        "反向包括：明确不再购买/退出该领域、立场与人设相反。垃圾/无用包括：互关求赞、加微领券、纯表情、灌水沙发、登录墙。完全不相干是正文与当前关键词没有任何关系。",
        "弱相关、相邻场景、只提到一次对象的内容应保留。不要因为没有复述最细职业标签就拒绝。",
        `候选：${JSON.stringify(candidatePayload)}`,
      ].join("\n") }] }],
      { temperature: 0, maxOutputTokens: 2048 },
      buildAbortSignalTimeout(Math.max(1_000, args.timeoutMs || 31_000)),
      {
        attemptTimeoutMs: ({ index }) => index === 0
          ? Math.min(5_000, Math.max(1_000, args.timeoutMs || 31_000))
          : Math.min(19_000, Math.max(1_000, args.timeoutMs || 31_000)),
        isUsableResponse: (data) => parseSentimentHotSemanticDecision(extractText(data)) !== null,
        isRetryableError: isTextModelFallbackError,
      },
    );
    const decision = parseSentimentHotSemanticDecision(extractText(result.data));
    const rejectedIds = new Set(decision?.rejectedIds || []);
    const acceptedIds = new Set(
      decision && decision.rejectedIds
        ? candidatePayload.map((item) => item.id).filter((id) => !rejectedIds.has(id))
        : (decision?.acceptedIds || []),
    );
    if (args.allowRecovery !== false && args.searchMode === "strict" && !decision?.rejectedIds && acceptedIds.size < args.limit) {
      const remainingCandidates = candidatePayload.filter((candidate) => !acceptedIds.has(candidate.id));
      if (remainingCandidates.length > 0) {
        const recovery = await callTextUnderstandingModelWithFallback(
          resolveSentimentHotTextModelPreference(),
          [{ role: "user", parts: [{ text: [
            "你是严格模式热点候选的第二轮语义复核器。只输出 JSON，不要解释，不要 Markdown。",
            "输出格式：{\"acceptedIds\":[\"候选ID\"]}。只返回第一轮未通过、但可以作为当前人设直接父领域专业讨论的候选。",
            `人设主领域：${args.strategy.domainSummary || cleanText(args.archive.content)}`,
            `严格接受词：${args.strategy.strictAcceptTerms.join("、")}`,
            `可用于直接父领域补充的相邻词：${args.strategy.normalAcceptTerms.join("、")}`,
            `明确排除词：${args.strategy.rejectTerms.join("、") || "无"}`,
            `本轮还需要最多 ${Math.max(0, args.limit - acceptedIds.size)} 条。允许当前人设所属直接父领域的产品、故障、安全、维修、行业、消费与使用场景；不要求复述最细职业标签。拒绝不同产业、同名词、泛生活和正文无关内容。`,
            `候选：${JSON.stringify(remainingCandidates)}`,
          ].join("\n") }] }],
          { temperature: 0, maxOutputTokens: 2048 },
          buildAbortSignalTimeout(45_000),
          {
            attemptTimeoutMs: 20_000,
            isUsableResponse: (data) => parseSentimentHotSemanticAcceptedIds(extractText(data)) !== null,
            isRetryableError: isTextModelFallbackError,
          },
        );
        const supplementalIds = parseSentimentHotSemanticAcceptedIds(extractText(recovery.data)) || [];
        supplementalIds.slice(0, Math.max(0, args.limit - acceptedIds.size)).forEach((id) => acceptedIds.add(id));
      }
    }
    const acceptedCandidateIds = new Set([...acceptedIds]
      .map((alias) => candidateAliases.get(alias))
      .filter((id): id is string => Boolean(id)));
    const unknownIds = new Set(unknown.map((candidate) => candidate.id));
    const tagged = args.candidates.map((candidate) => unknownIds.has(candidate.id) ? {
      ...candidate,
      metrics: {
        ...(candidate.metrics || {}),
        semanticRelevant: acceptedCandidateIds.has(candidate.id),
        semanticRelevanceScope: scope,
        semanticContentHash: contentHash(candidate),
      },
    } : candidate);
    const accepted = tagged.filter((candidate) => (candidate.metrics as any)?.semanticRelevanceScope === scope
      && (candidate.metrics as any)?.semanticRelevant === true);
    args.warnings.push(`模型语义复核通过 ${accepted.length}/${tagged.length} 篇候选。`);
    return { accepted, tagged, scope };
  } catch (error) {
    args.warnings.push(`模型语义复核暂不可用，已保留正文领域信号过滤：${error instanceof Error ? error.message : String(error)}`);
    const safeFallback = args.candidates.filter((candidate) => (candidate.metrics as any)?.globalPersonaBackfill !== true);
    return { accepted: safeFallback, tagged: safeFallback };
  }
}

export function buildSentimentHotSearchStrategyCacheKey(args: {
  archive?: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>;
  prompt?: string;
  /** Accepted for payload compatibility, but deliberately excluded from hot-search strategy. */
  memorySummaries?: string[];
  writingLocale?: string;
  personaText: string;
}): string {
  const archive = args.archive || {};
  const setup = archive.setup || {};
  const payload = {
    version: SENTIMENT_HOT_SEARCH_STRATEGY_VERSION,
    id: cleanText((archive as any).id),
    name: cleanText(archive.name),
    setup: {
      genres: Array.isArray((setup as any).genres) ? (setup as any).genres.map(cleanText).filter(Boolean) : [],
      trendTopics: Array.isArray((setup as any).trendTopics) ? (setup as any).trendTopics.map(cleanText).filter(Boolean) : [],
      chineseScript: cleanText((setup as any).chineseScript || (setup as any).script || (setup as any).locale),
      targetMarket: cleanText((setup as any).targetMarket || (setup as any).market || (setup as any).region),
    },
    // Free-form user supplements are deliberately excluded from both model
    // input and cache identity. The persona's stable topic fields are enough.
    writingLocale: cleanText(args.writingLocale),
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function readSentimentHotSearchStrategyCache(): Record<string, { at: string; strategy: SentimentHotSearchStrategy }> {
  try {
    if (!fs.existsSync(SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readCachedSentimentHotSearchStrategy(cacheKey: string): SentimentHotSearchStrategy | null {
  const row = readSentimentHotSearchStrategyCache()[cacheKey];
  if (!row?.strategy || Date.now() - new Date(row.at).getTime() > SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_TTL_MS) return null;
  return sentimentHotStrategyHasModelTerms(row.strategy) && sentimentHotStrategyUsesThreadsChinese(row.strategy) ? row.strategy : null;
}

function readCachedSentimentHotSearchStrategyForArgs(args: {
  archive?: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>;
  prompt?: string;
  writingLocale?: string;
}): SentimentHotSearchStrategy | null {
  const cacheKey = buildSentimentHotSearchStrategyCacheKey({ ...args, personaText: "" });
  return readCachedSentimentHotSearchStrategy(cacheKey);
}

function writeCachedSentimentHotSearchStrategy(cacheKey: string, strategy: SentimentHotSearchStrategy) {
  if (!sentimentHotStrategyHasModelTerms(strategy) || !sentimentHotStrategyUsesThreadsChinese(strategy)) return;
  const written = withExclusiveJsonFileLock(SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE, () => {
    const state = readSentimentHotSearchStrategyCache();
    state[cacheKey] = { at: new Date().toISOString(), strategy };
    for (const [key, row] of Object.entries(state)) {
      if (!row?.at || Date.now() - new Date(row.at).getTime() > SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_TTL_MS) delete state[key];
    }
    fs.mkdirSync(path.dirname(SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE), { recursive: true });
    const tempFile = `${SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempFile, SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE);
  });
  if (!written) console.warn("[sentiment_hot_cache] strategy cache write skipped because the file is busy");
}

export function resolveSentimentHotTextModelPreference(): string {
  const config = readRuntimeApiConfig() as Record<string, unknown>;
  const configured = [
    config.llmFreeModelPriorityOrder,
    config.llm_free_model_priority_order,
    config.llmModelPriorityOrder,
    config.llm_model_priority_order,
    config.llmDefaultModelGpt,
    config.llm_default_model_gpt,
    config.llmDefaultModel,
    config.llm_default_model,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
  const configuredModels = configured.split(/[,\n]/).map((model) => model.trim()).filter(Boolean);
  if (configuredModels.length) return [...new Set(configuredModels)].join(",");
  return SENTIMENT_HOT_KEYWORD_MODEL
    .split(/[,\n]/)
    .map((model) => model.trim())
    .filter(Boolean)
    .join(",");
}

async function buildSentimentHotSearchStrategyWithModel(args: {
  archive?: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>;
  prompt?: string;
  writingLocale?: string;
  warnings: string[];
  timeoutMs?: number;
  useCache?: boolean;
}): Promise<SentimentHotSearchStrategy> {
  const archive = args.archive || {};
  const setup = archive.setup || {};
  const personaText = personaHotStrategySourceText(archive);
  if (!personaText.trim()) return emptySentimentHotSearchStrategy();
  const chineseScript = cleanText((setup as any).chineseScript || (setup as any).script || (setup as any).locale).toLowerCase();
  const targetMarket = cleanText((setup as any).targetMarket || (setup as any).market || (setup as any).region).toLowerCase();
  const explicitWritingLocale = cleanText(args.writingLocale).toLowerCase();
  const prefersTraditional = explicitWritingLocale === "zh-tw"
    || (!explicitWritingLocale && /traditional|繁|tw|taiwan|hk|hong\s*kong|mo|macau|臺|台灣|香港|澳門/u.test(`${chineseScript} ${targetMarket}`)
    && !/simplified|简|簡|cn|mainland|china|中国|中國/u.test(`${chineseScript} ${targetMarket}`));
  const chineseSearchInstruction = prefersTraditional
    ? "关键词必须使用繁體中文输出，禁止混入简体中文；专有名词除外。搜索词必须是平台上真实用户会直接搜索的高流量词。"
    : "关键词必须使用简体中文输出，禁止混入繁體中文；专有名词除外。搜索词必须是平台上真实用户会直接搜索的高流量词。";
  const cacheKey = buildSentimentHotSearchStrategyCacheKey({
    archive,
    // User-entered supplements are intentionally excluded. Hot search should
    // be stable for the same persona instead of creating a new strategy/cache
    // branch for every ad-hoc sentence.
    writingLocale: args.writingLocale,
    personaText,
  });
  const cached = args.useCache === false ? null : readCachedSentimentHotSearchStrategyForArgs({
    archive,
    writingLocale: args.writingLocale,
  });
  if (cached) return cached;

  // Collector nodes must never invent persona keywords. The new application
  // host is the only keyword-model authority and passes its model output to the
  // old collector as explicit manual keywords.
  if (/^(?:1|true|yes|on)$/i.test(String(process.env.TG_HOT_DISABLE_KEYWORD_MODEL || "").trim())) {
    args.warnings.push("当前采集节点未启用热点关键词模型，请由新机生成关键词后再执行抓取。");
    return emptySentimentHotSearchStrategy();
  }

  try {
    const modelPreference = resolveSentimentHotTextModelPreference();
    const totalTimeoutMs = Math.max(8_000, args.timeoutMs || 38_000);
    const configuredModelCount = Math.max(1, getTextUnderstandingModelFallbacks(modelPreference).length);
    const keywordStartedAt = Date.now();
    const attemptTimeoutMs = ({ index }: { index: number }) => {
      const remaining = totalTimeoutMs - (Date.now() - keywordStartedAt);
      if (configuredModelCount <= 1) return Math.max(8_000, remaining - 500);
      // Old personas often finish in 10-20s. A 22s first-attempt cap kills the
      // same model when a new persona needs 25-40s, then the fallback burns
      // the rest of the budget and the UI only sees a timeout.
      if (index === 0) return Math.min(50_000, Math.max(20_000, remaining - 16_000));
      return Math.max(15_000, remaining - 1_000);
    };
    const result = await callTextUnderstandingModelWithFallback(
      modelPreference,
      [{
        role: "user",
        parts: [{
          text: [
            "你是 Threads / Instagram 热点搜索策略模型。必须为当前这个人设生成搜索策略，不得套用其他人设的行业词，也不得因为简介难写就拒写或交空结果。",
            "人设名称只是对外称呼。必须按内容领域和职业理解；禁止把俚语化名称理解成色情、擦边或开车含义，也不得因此拒写或返回空候选。",
            "只输出 JSON 对象，不要解释，不要 Markdown。",
            "JSON 结构：",
            "{\"primaryQueries\":[\"...\"],\"domainExpansion\":[\"...\"],\"rejectTerms\":[\"...\"],\"domainSummary\":\"...\"}",
            "所有列表字段必须是 JSON 数组。字段数量：primaryQueries 正好 10 个，domainExpansion 正好 10 个，rejectTerms 4-8 个，domainSummary 一句话。",
            "合计必须给出 20 个互不重复的可搜索词，供下游按 10 个一批轮换搜索。不要多也不要少。",
            "",
            "先看人设名称和主题。若简介清楚写了职业、产品、场所或作品，就按这些扩词。",
            "若简介很难过关——只有性格、外貌、日常、搞笑、吐槽、段子，没有现成物件名词——你必须先自己扩展：这个人会持续对公众讲什么，把该主题扩成可搜索的具体对象（物、场景、作品、槽点对象、职场物件），再输出搜索词。",
            "扩展必须仍属于这个人设会讲的内容，不能换成无关行业。禁止因为简介空泛、擦边或不好写就拒写或返回空候选。",
            "primaryQueries 以 2-4 个汉字的具体物件、服务、场所、工具、产品或作品名为主，互不重复，公众会直接拿去搜。",
            "domainExpansion 再补 10 个同一领域、与 primaryQueries 不重复的可搜物件。两个主题并存时必须分别扩词。主题名本身最多保留 1 次，其余必须更具体。",
            "风格意图只用于理解这类帖子常见，不要写进搜索词。禁止输出带这些后缀或整词的合成搜索词：攻略、教程、教學、教学、分享、心得、评测、測評、推荐、推薦、經驗、经验。",
            "若该领域常见攻略或教程帖，请改写成更具体的可搜物件，例如存股、融資、配息、當沖、槓桿、信用交易，而不是融資攻略、理財心得、台股分享。",
            "不要用短词再拼更长的标签。有融資可以同时保留更具体的融資券，但不要写融資攻略、融資分享、融資額這種重复加长。",
            "禁止单独输出空词：日常、搞笑、生活、攻略、经验、好物、气氛、爱好者、大叔、便宜、烟火气、教程、分享、心得。",
            "禁止外貌、性格、语气、穿著、面料、体型、姿势、道具、图片视觉描述。",
            "生活状态词（慢生活、退休生活、健康生活、家务、居家清洁）除非人设主业本身就是家政、养老或对应行业，否则禁止作为搜索词。",
            "禁止把两个主题名拼成一个词。",
            "rejectTerms 写最容易误召回的其他行业，不能排除主领域。",
            chineseSearchInstruction,
            "不要输出人格、推理过程或自我介绍。",
            "",
            "当前人设资料：",
            personaText,
          ].join("\n"),
        }],
      }],
      { temperature: 0.1, maxOutputTokens: 1400, responseMimeType: "application/json" },
      buildAbortSignalTimeout(totalTimeoutMs),
      {
        isUsableResponse: (data) => {
          const candidate = parseSentimentHotSearchStrategy(extractText(data), {
            archiveName: cleanText(archive.name),
            sourceText: personaText,
          });
          const queries = [...new Set((candidate.primaryQueries || []).map(cleanText).filter(Boolean))];
          const expansion = [...new Set((candidate.broadQueries || []).map(cleanText).filter(Boolean))];
          const uniqueCount = new Set([...queries, ...expansion]).size;
          const hasChinese = ([...queries, ...expansion].join("").match(/[\u3400-\u9fff]/gu) || []).length >= 16;
          if (queries.length < 10 || uniqueCount < 18 || !hasChinese) {
            console.info(`[sentiment_hot_model_unusable] reason=${queries.length < 10 || uniqueCount < 18 ? "missing_terms" : "not_chinese"} primary=${queries.length} unique=${uniqueCount} sample=${JSON.stringify(queries.slice(0, 8))}`);
            return false;
          }
          return true;
        },
        isRetryableError: isTextModelFallbackError,
        attemptTimeoutMs,
        onFallback: ({ from, to, error }) => {
          console.info(`[sentiment_hot_model_fallback] from=${JSON.stringify(from)} to=${JSON.stringify(to)} error=${JSON.stringify(error)}`);
        },
      },
    );
    const strategy = parseSentimentHotSearchStrategy(extractText(result.data), {
      archiveName: cleanText(archive.name),
      sourceText: personaText,
    });
    if (resolveSentimentHotModelStrategyKeywords(strategy, "strict").length >= 8) {
      console.info(`[sentiment_hot_model_strategy] model=${JSON.stringify(result.model)} domain=${JSON.stringify(strategy.domainSummary)}`);
      writeCachedSentimentHotSearchStrategy(cacheKey, strategy);
      return strategy;
    }
    args.warnings.push("模型未返回符合当前人设核心的有效热点关键词。");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.info(`[sentiment_hot_model_failed] error=${JSON.stringify(detail).slice(0, 400)}`);
    if (/timeout|timed\s*out|abort|超时|超時/i.test(detail)) {
      args.warnings.push("热点关键词生成超时，请稍后重试。");
    } else if (/安全策略|未返回候選|未返回候选|返回空|閘道器截斷|网关截断/i.test(detail)) {
      args.warnings.push("热点关键词模型未返回可用结果，请稍后重试。");
    } else {
      args.warnings.push("热点关键词服务暂时不可用，请稍后重试。");
    }
  }
  return emptySentimentHotSearchStrategy();
}

export async function warmSentimentHotSearchStrategy(archive: PersonaArchive): Promise<boolean> {
  const warnings: string[] = [];
  const strategy = await buildSentimentHotSearchStrategyWithModel({
    archive,
    warnings,
    timeoutMs: 58_000,
  });
  return sentimentHotStrategyHasModelTerms(strategy);
}

export async function prepareSentimentHotKeywords(args: {
  archive?: PersonaArchive;
  prompt?: string;
  writingLocale?: string;
  searchMode?: SentimentHotSearchMode;
  refresh?: boolean;
  forceRegenerate?: boolean;
}): Promise<PrepareSentimentHotKeywordsResult> {
  const warnings: string[] = [];
  const searchMode = normalizeSentimentHotSearchMode(args.searchMode);
  const strategy = await buildSentimentHotSearchStrategyWithModel({
    archive: args.archive,
    writingLocale: args.writingLocale,
    warnings,
    // Leave enough room for the dedicated primary model plus one configured
    // fallback once per 24-hour strategy cache. Subsequent fetches reuse the
    // cached keyword plan and keep the old-host collection path fast.
    timeoutMs: 68_000,
    // Candidate refreshes reuse the remaining keyword batch. Only the new-host
    // controller can mark a complete plan exhausted and request regeneration.
    useCache: args.forceRegenerate !== true,
  });
  const keywords = resolveSentimentHotModelStrategyKeywords(strategy, searchMode);
  if (keywords.length === 0 && !warnings.some((warning) => /关键词生成|搜索策略/.test(warning))) {
    warnings.push("热点关键词不可用，请稍后重试。");
  }
  return { keywords, searchMode, warnings };
}

export function cleanSentimentCandidateContent(value: unknown): string {
  let text = cleanText(value);
  text = text
    .replace(/\s*Log in for more threads about this topic\.\s*Log in\s*Log in or sign up for Threads?.*$/i, "")
    .replace(/\s*Log in or sign up for Threads?.*$/i, "")
    .replace(/\s*Log in for more.*$/i, "")
    .replace(/\s*登入以取得更多有關此主題的串文。.*$/i, "")
    .replace(/\s*登入或註冊 Threads.*$/i, "")
    .replace(/\s*登录以获取更多有关此话题的串文。.*$/i, "")
    .replace(/\s*登录或注册 Threads.*$/i, "")
    .replace(/(?:https?:\/\/)?(?:www\.)?(?:threads\.net|instagram\.com)\s*[›>]\s*/gi, " ")
    .replace(/(?:^|\s)(?:@[\w.-]+|t)\s*[›>]\s*(?:post\s*)?/gi, " ")
    .replace(/\s*(?:相關|相关|广告|廣告)\s+.*$/i, "")
    .replace(/\s*&middot;\s*/gi, " ")
    .replace(/\bThreads\s*\.\.\.\s*Threads\b/gi, " ")
    .replace(/\bInstagram\s*\.\.\.\s*Instagram\b/gi, " ")
    .replace(/\bsite:(?:threads\.net|instagram\.com)\b/gi, " ")
    .replace(/^\s*[A-Za-z0-9_-]{8,}\s+/, "")
    .replace(/(?:^|\s)(?:讚|赞|留言|回覆|回复|轉發|转发|分享|喜歡|喜欢)\s*\d+(?:[.,]\d+)?\s*[Kk萬万]?(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function normalizeSentimentCandidateSourceUrl(value: unknown): string {
  return cleanText(value)
    .replace(/[)\].,，。]+$/g, "")
    .replace(/#.*$/g, "")
    .replace(/[?&]__r=[^&]+/g, "")
    .replace(/[?&]utm_[^=&]+=[^&]+/g, "")
    .replace(/[?&]$/, "")
    .toLowerCase();
}

function sentimentCandidateDedupeKey(candidate: SentimentHotCandidate, contentOverride?: string): string {
  const rawSourceUrl = cleanText(candidate.sourceUrl);
  const sourceUrl = normalizeSentimentCandidateSourceUrl(rawSourceUrl);
  if (sourceUrl && !/#candidate-\d+$/i.test(rawSourceUrl)) return `${candidate.platform}:url:${sourceUrl}`;
  const content = cleanSentimentCandidateContent(contentOverride ?? candidate.content)
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .toLowerCase()
    .slice(0, 120);
  return `${candidate.platform}:content:${content || candidate.id}`;
}

function normalizeSentimentCandidateFingerprint(value: unknown): string {
  return cleanSentimentCandidateContent(value)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\u3400-\u9fffA-Za-z0-9]+/gu, "")
    .toLowerCase()
    .slice(0, 180);
}

function normalizeSentimentMediaFingerprint(candidate: SentimentHotCandidate): string {
  return (candidate.media || [])
    .map((item) => normalizeSentimentCandidateSourceUrl(item?.url || ""))
    .filter(Boolean)
    .slice(0, 4)
    .join("|");
}

function sentimentCandidateFinalDedupeKeys(candidate: SentimentHotCandidate, content: string): string[] {
  const keys = new Set<string>();
  if (candidate.id) keys.add(`id:${candidate.id}`);
  keys.add(sentimentCandidateDedupeKey(candidate, content));
  const sourceUrl = normalizeSentimentCandidateSourceUrl(candidate.sourceUrl);
  const postMatch = sourceUrl.match(/\/post\/([^/?#]+)/i) || sourceUrl.match(/\/p\/([^/?#]+)/i);
  if (postMatch?.[1]) keys.add(`${candidate.platform}:post:${postMatch[1].toLowerCase()}`);
  const mediaKey = normalizeSentimentMediaFingerprint(candidate);
  if (mediaKey) keys.add(`${candidate.platform}:media:${mediaKey}`);
  const textKey = normalizeSentimentCandidateFingerprint(content);
  if (textKey.length >= 24) keys.add(`${candidate.platform}:text:${textKey}`);
  if (textKey.length >= 40) keys.add(`${candidate.platform}:text-prefix:${textKey.slice(0, 80)}`);
  return [...keys];
}

function isLowQualitySentimentContent(value: string): boolean {
  const text = cleanText(value);
  if (text.length < 12) return true;
  if (/not all who wander are lost|link'?s not working|page is gone|go back to keep exploring/i.test(text)) return true;
  if (/^(?:Threads|Instagram)(?:\s*\.\.\.)?$/i.test(text)) return true;
  return false;
}

function isGarbageOrUselessSentimentContent(value: unknown): boolean {
  const text = cleanSentimentCandidateContent(value);
  if (!text) return true;
  if (isLowQualitySentimentContent(text)) return true;
  const compact = text.replace(/\s+/g, "");
  const hanCount = (compact.match(/[\u3400-\u9fff]/gu) || []).length;
  const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (/(.)\1{5,}/u.test(compact)) return true;
  if (hanCount < 8 && emojiCount >= Math.max(3, hanCount)) return true;
  if (/^(?:哈{2,}|呵{2,}|嘿{2,}|喔{2,}|哦{2,}|嗯{2,}|啊{2,}|哇{2,})$/u.test(compact)) return true;
  if (/^(?:第一|沙發|沙发|來了|来了|路过|路過|前排|打卡|签到|簽到)$/u.test(compact)) return true;
  if (/(?:互關|互关|互粉|求贊|求赞|求關注|求关注|關注我|关注我|加微信|加v|私訊領|私信领|点击主页|點擊主頁|主页领取|主頁領取)/u.test(text) && hanCount < 36) return true;
  if (/threads\s*(?:log\s*in|login)|join threads|log in with instagram|page is gone/i.test(text)) return true;
  if (/^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(text) && hanCount < 12) return true;
  return false;
}

function isCompletelyUnrelatedSentimentContent(
  candidate: SentimentHotCandidate,
  keywords: string[] = [],
  searchMode: SentimentHotSearchMode = "strict",
): boolean {
  if (meaningfulNeedles(keywords).length === 0) return false;
  return !candidateMatchesCurrentKeywords(candidate, keywords, searchMode);
}

export function isChineseSentimentCandidate(value: unknown): boolean {
  const text = cleanText(value);
  const hanCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  if (hanCount < 6) return false;
  const kanaCount = (text.match(/[\u3040-\u30ff]/gu) || []).length;
  if (kanaCount >= 3 && kanaCount >= hanCount * 0.08) return false;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  return hanCount >= 12 || hanCount >= latinCount * 0.3;
}

export async function fetchSentimentCookieStatuses(): Promise<SentimentCookieStatus[]> {
  const profiles = readSentimentBrowserAuthProfilesConfig();
  return (["threads", "instagram"] as SentimentHotPlatform[]).map((platform) => buildSentimentCookieStatusFromProfile(platform, profiles.find((item) => sentimentProfileMatchesPlatform(item, platform))));
}

function sentimentCookieStatusHasUsableCookies(status: SentimentCookieStatus): boolean {
  if (status.hasRequiredSessionCookie === false) return false;
  if (status.health === "healthy" || status.health === "watch" || status.health === "degraded") return true;
  const match = status.message.match(/有效 Cookie\s*(\d+)/);
  return Boolean(match && Number(match[1]) > 0);
}

function sentimentCookiePlatformLabel(platform: SentimentHotPlatform): string {
  return platform === "threads" ? "Threads" : "Instagram";
}

function sentimentCookieStatusNeedsRefresh(status: SentimentCookieStatus): boolean {
  if (!sentimentCookieStatusHasUsableCookies(status)) return false;
  if (status.authorizationNeedsRefresh === true) return true;
  if (Number(status.expiredCookieCount || 0) > 0) return true;
  if (Number(status.expiringSoonCookieCount || 0) > 0) return true;
  return status.recommendedAction === "refresh-profile-cookies";
}

export function normalizeSentimentBrowserCookieExpiry(value: unknown): number {
  let expires = Number(value);
  if (!Number.isFinite(expires) || expires <= 0) return -1;
  while (expires > 253_402_300_799) expires /= 1000;
  return expires;
}

function normalizeCookieForBrowserAuth(cookie: any, fallbackDomain: string) {
  if (!cookie?.name || !cookie?.value) return null;
  const expires = normalizeSentimentBrowserCookieExpiry(cookie.expires);
  const sameSite = ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined;
  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain || fallbackDomain || ".threads.net"),
    path: String(cookie.path || "/"),
    expires,
    httpOnly: Boolean(cookie.httpOnly || cookie.http_only),
    secure: cookie.secure !== false,
    sameSite,
  };
}

export async function refreshSentimentBrowserCookiesForPlatform(platform: SentimentHotPlatform): Promise<{ ok: boolean; message: string }> {
  const configPath = resolveSentimentConfigPath();
  if (!fs.existsSync(configPath)) return { ok: false, message: `${sentimentCookiePlatformLabel(platform)} Cookie 配置不存在。` };
  const profile = readSentimentBrowserAuthProfilesConfig().find((item: any) => sentimentProfileMatchesPlatform(item, platform));
  if (!profile) return { ok: false, message: `${sentimentCookiePlatformLabel(platform)} Cookie 配置不存在。` };

  const cookies = readSentimentBrowserAuthCookies(platform)
    .map((cookie: any) => normalizeCookieForBrowserAuth(cookie, profile.domain || `${platform}.net`))
    .filter(Boolean);
  if (!cookies.length) return { ok: false, message: `${sentimentCookiePlatformLabel(platform)} 缺少有效 Cookie，无法自动刷新；需要先人工重新授权登录。` };

  const authUrl = cleanText(profile.authUrl)
    || cleanText(Array.isArray(profile.authUrls) ? profile.authUrls[0] : "")
    || (platform === "threads" ? "https://www.threads.net/" : "https://www.instagram.com/");
  const cookieUrls = [
    authUrl,
    platform === "threads" ? "https://www.threads.net/" : "https://www.instagram.com/",
    platform === "threads" ? "https://www.threads.com/" : "",
  ].filter(Boolean);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch(buildLocalChromiumLaunchOptions());
  try {
    const context = await browser.newContext({
      locale: "zh-TW",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    await context.addCookies(cookies as any[]);
    const page = await context.newPage();
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const href = page.url();
    const stillLoggedOut = /accounts\/login|log in|login|登入|登录|使用 Instagram|Instagram 帳號|Instagram 账号/i.test(`${title}\n${href}\n${bodyText}`);
    const refreshedCookies = activeUniqueCookies((await context.cookies(cookieUrls)).map((cookie) => normalizeCookieForBrowserAuth(cookie, profile.domain || `${platform}.net`)).filter(Boolean));
    await context.close().catch(() => undefined);
    if (stillLoggedOut || refreshedCookies.length === 0) {
      return { ok: false, message: `${sentimentCookiePlatformLabel(platform)} 自动刷新未通过真实登录态检测${stillLoggedOut ? "：页面返回登录墙" : ""}；请重新登录可用账号并等待授权助手自动同步。` };
    }
    if (platform === "threads" && !hasValidThreadsSessionCookieForDomain(refreshedCookies, "threads.com")) {
      return { ok: false, message: "Threads sessionid was read, but threads.com cleared or did not retain the login session. Re-login in the authorization helper and sync again." };
    }
    const runtime = await ensureSentimentRuntime().catch((error: any) => ({
      ok: false,
      url: resolveSentimentBackendUrl(),
      warning: error instanceof Error ? error.message : String(error || "unknown"),
    }));
    if (!runtime.ok) {
      return {
        ok: false,
        message: `${sentimentCookiePlatformLabel(platform)} Cookie auto refresh could not start sentiment backend: ${runtime.warning || "unknown"}`,
      };
    }
    const response = await fetch(`${runtime.url}/api/sentiment/browser-auth/cookies`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentiment-browser-auth": readSentimentBrowserAuthToken(),
      },
      body: JSON.stringify({
        profileKey: profile.key || platform,
        sourceKey: profile.sourceKey || platform,
        domain: profile.domain || new URL(authUrl).hostname,
        cookies: refreshedCookies,
      }),
      signal: buildAbortSignalTimeout(8000),
    });
    if (!response.ok) return { ok: false, message: `${sentimentCookiePlatformLabel(platform)} Cookie 回写失败：HTTP ${response.status}` };
    return { ok: true, message: `${sentimentCookiePlatformLabel(platform)} Cookie 已自动刷新。` };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function activeUniqueCookies(cookies: any[]): any[] {
  const nowSeconds = Date.now() / 1000;
  const byKey = new Map<string, any>();
  for (const cookie of cookies) {
    const expires = Number(cookie?.expires);
    if (Number.isFinite(expires) && expires > 0 && expires <= nowSeconds) continue;
    if (!cookie?.name || !cookie?.value) continue;
    byKey.set(`${cookie.name}|${cookie.domain}|${cookie.path || "/"}`, cookie);
  }
  return [...byKey.values()].slice(0, 120);
}

async function refreshSentimentBrowserCookies(statuses: SentimentCookieStatus[], warnings: string[]) {
  const targets = statuses.filter(sentimentCookieStatusNeedsRefresh).slice(0, 2);
  if (!targets.length) return statuses;
  const refreshed: SentimentHotPlatform[] = [];
  for (const status of targets) {
    const result = await refreshSentimentBrowserCookiesForPlatform(status.platform).catch((error) => ({
      ok: false,
      message: `${sentimentCookiePlatformLabel(status.platform)} Cookie 自动刷新失败：${error instanceof Error ? error.message : String(error)}`,
    }));
    warnings.push(result.message);
    if (result.ok) refreshed.push(status.platform);
  }
  if (!refreshed.length) return statuses;
  const nextStatuses = await fetchSentimentCookieStatuses().catch(() => statuses);
  return nextStatuses;
}

async function triggerRealtimeSentimentScan(platforms: SentimentHotPlatform[], warnings: string[]) {
  const sources = [...new Set(platforms)].filter((platform) => platform === "threads" || platform === "instagram");
  if (!sources.length) return;
  try {
    const response = await fetch(`${resolveSentimentBackendUrl()}/api/sentiment/scan-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "manual", mode: "fast", sources, days: 2 }),
      signal: buildAbortSignalTimeout(5000),
    });
    if (!response.ok) {
      warnings.push(`实时扫描触发失败：HTTP ${response.status}`);
      return;
    }
    const json = await response.json().catch(() => ({}));
    warnings.push(json?.alreadyRunning ? "舆情后端已有实时扫描在运行，已复用当前任务。" : "已触发舆情后端实时扫描，结果会持续进入候选库。");
  } catch (error) {
    warnings.push("实时扫描触发失败：" + (error instanceof Error ? error.message : String(error)));
  }
}

function waitSentiment(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMoreSentimentHotCandidates(args: {
  archiveId: string;
  keywords: string[];
  candidates: SentimentHotCandidate[];
  limit: number;
  excludeShown: boolean;
  searchMode: SentimentHotSearchMode;
  freshnessDays: number;
}): Promise<SentimentHotCandidate[]> {
  let candidates = args.candidates;
  for (let attempt = 0; attempt < 3 && candidates.length < args.limit; attempt += 1) {
    await waitSentiment(2500);
    const databaseCandidates = await readCandidatesFromDatabase({
      archiveId: args.archiveId,
      keywords: args.keywords,
      limit: Math.max(args.limit * 20, 200),
      excludeShown: args.excludeShown,
    }).catch(() => []);
    if (!databaseCandidates.length) continue;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
    for (const candidate of databaseCandidates) {
      if (!candidateMatchesOperationalFreshness(candidate, args.freshnessDays)) continue;
      const dedupeKey = sentimentCandidateDedupeKey(candidate);
      if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
        byId.set(candidate.id, candidate);
        byKey.add(dedupeKey);
      }
      if (byId.size >= args.limit) break;
    }
    candidates = sortSentimentHotCandidatePool([...byId.values()], args.keywords, args.limit, args.searchMode);
  }
  return candidates;
}

async function fetchSentimentHotCandidatesUnlocked(args: {
  archive?: PersonaArchive;
  prompt?: string;
  writingLocale?: string;
  keywords?: string[];
  limit?: number;
  refresh?: boolean;
  searchMode?: SentimentHotSearchMode;
  freshnessDays?: number;
  freshnessPolicy?: SentimentHotFreshnessPolicy;
  /** Set false for background pool refills that were never shown to a user. */
  recordShown?: boolean;
  /** Test-only mode: exclude cache/database/history backfills and do not write shown history. */
  liveOnly?: boolean;
  sourcePolicy?: "reader_first" | "reader_only" | "authenticated_only";
  platform?: SentimentHotPlatform | string;
}): Promise<FetchSentimentHotCandidatesResult> {
  const startedAt = Date.now();
  // A scheduled Spider refill may legitimately wait for the bounded shared
  // anonymous 20 RPM window. Interactive authenticated requests retain the
  // original 30-second end-to-end budget.
  const totalTimeoutMs = args.sourcePolicy === "reader_only"
    ? SENTIMENT_HOT_READER_ONLY_TOTAL_TIMEOUT_MS
    : SENTIMENT_HOT_TOTAL_TIMEOUT_MS;
  const warnings: string[] = [];
  const archive = args.archive;
  const archiveId = cleanText(archive?.id) || "default";
  const searchMode = normalizeSentimentHotSearchMode(args.searchMode);
  const requestedPlatform = normalizeRequestedHotPlatform(args.platform) ?? "threads";
  const liveFetchTargets = resolveHotLiveFetchTargets(requestedPlatform);
  const submittedManualKeywords = Array.isArray(args.keywords)
    ? args.keywords.map(cleanText).filter((item) => isConcreteSearchKeyword(item))
    : [];
  const manualKeywords = resolveSentimentHotManualQueryKeywords(submittedManualKeywords, null, searchMode);
  const freshnessPolicy = normalizeSentimentHotFreshnessPolicy(args.freshnessPolicy);
  const freshnessDays = normalizeSentimentHotFreshnessDays(
    args.freshnessDays ?? (args.refresh === true ? DEFAULT_REFRESH_FRESHNESS_DAYS : 0),
  );
  const strictFreshness = freshnessPolicy === "strict";
  const liveOnlyRefresh = args.liveOnly === true;
  // A strict request means exactly the selected publication-time window.
  // Never widen it to fill a sparse result set: that would turn a "7 days"
  // request into older content without the user asking for it.
  const operationalFreshnessDays = strictFreshness && freshnessDays > 0
    ? freshnessDays
    : 0;
  // Strict tests enforce the publishedAt window, but may reuse a fresh
  // same-persona cache row from the last 24 hours. This keeps tests reliable
  // when the live source is rate-limited without admitting stale history.
  const strictFreshOnly = strictFreshness && freshnessDays > 0;
  const limit = args.limit || 10;
  const prefetchedStrategy = manualKeywords.length > 0
    ? null
    : readCachedSentimentHotSearchStrategyForArgs({
        archive,
        writingLocale: args.writingLocale,
      });
  if (prefetchedStrategy) {
    applyPersonaGuardToSentimentHotStrategy({ strategy: prefetchedStrategy });
  }
  const provisionalKeywords = manualKeywords.length > 0
    ? manualKeywords
    : resolveSentimentHotModelStrategyKeywords(prefetchedStrategy, searchMode);
  const provisionalQueryKeywords = prefetchedStrategy
    ? (manualKeywords.length > 0 ? resolveSentimentHotManualQueryKeywords(submittedManualKeywords, prefetchedStrategy, searchMode) : resolveSentimentHotModelQueryKeywords(prefetchedStrategy, searchMode))
    : provisionalKeywords;
  const provisionalKeywordBatches = [provisionalQueryKeywords];
  const provisionalCacheStartedAt = Date.now();
  const provisionalCachedCandidates = !liveOnlyRefresh && meaningfulNeedles(provisionalKeywords).length > 0
    ? readThreadsSearchCandidateCache(archiveId, provisionalKeywords, Math.max(limit * 4, 40), true, searchMode, requestedPlatform)
      .filter((candidate) => candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays))
    : [];
  console.info(`[sentiment_hot_stage] label=provisional-cache durationMs=${Date.now() - provisionalCacheStartedAt}`);
  const provisionalCandidateMap = new Map<string, SentimentHotCandidate>();
  for (const candidate of provisionalCachedCandidates) {
    const dedupeKey = sentimentCandidateDedupeKey(candidate);
    if (!provisionalCandidateMap.has(dedupeKey)) provisionalCandidateMap.set(dedupeKey, candidate);
  }
  const provisionalCandidatesForReadiness = [...provisionalCandidateMap.values()];
  const provisionalReadyCount = prefetchedStrategy
    ? provisionalCandidatesForReadiness.filter((candidate) => candidateMatchesStrategyOrVerifiedFreshFallback(candidate, prefetchedStrategy, searchMode)).length
    : sortRelevantHotCandidates(provisionalCandidatesForReadiness, provisionalKeywords, Math.max(limit * 4, 40), searchMode).length;
  // A refresh must use one live search after the final model strategy is ready.
  // Starting a provisional browser search here can race the final search and
  // launch two Chromium sessions for the same persona, which makes Threads
  // rate-limit the second request and intermittently hide the GraphQL template.
  const provisionalSourceAttempted = false;
  const provisionalSourcePromise = provisionalSourceAttempted
    ? Promise.all(provisionalKeywordBatches.map((batch) => fetchThreadsSearchPageCandidates({
        archiveId,
        keywords: provisionalKeywords,
        queryKeywords: batch,
        limit: Math.max(limit, 25),
        refresh: true,
        searchMode,
        deadlineAt: Date.now() + SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS,
        warnings,
      }).catch(() => [])))
      .then((batches) => {
        const byKey = new Map<string, SentimentHotCandidate>();
        for (const candidate of batches.flat()) {
          const key = sentimentCandidateDedupeKey(candidate);
          if (!byKey.has(key)) byKey.set(key, candidate);
        }
        return [...byKey.values()];
      })
    : Promise.resolve([] as SentimentHotCandidate[]);
  const strategyTimeoutMs = resolveSentimentHotStrategyTimeoutMs(
    args.refresh === true,
    remainingSentimentHotTotalBudgetMs(startedAt, 18_000, totalTimeoutMs),
  );
  const strategyResult = manualKeywords.length > 0
    ? emptySentimentHotSearchStrategy()
    : await measureSentimentStage(
      warnings,
      "search-strategy",
      () => withSentimentTimeout(
        buildSentimentHotSearchStrategyWithModel({ archive, writingLocale: args.writingLocale, warnings, timeoutMs: strategyTimeoutMs, useCache: true }),
        strategyTimeoutMs + 250,
        emptySentimentHotSearchStrategy(),
      ),
    );
  if (strategyResult) {
    applyPersonaGuardToSentimentHotStrategy({ strategy: strategyResult });
  }
  const hasUsableSearchStrategy = Boolean(strategyResult && sentimentHotStrategyHasModelTerms(strategyResult));
  const hasModelStrategy = Boolean(strategyResult && sentimentHotStrategyHasModelTerms(strategyResult));
  const useModelStrategyForAcceptance = manualKeywords.length === 0 && hasModelStrategy && Boolean(strategyResult);
  const deferLiveSearchRelevanceGate = manualKeywords.length > 0 || hasModelStrategy;
  const keywords = manualKeywords.length > 0
    ? manualKeywords
    : resolveSentimentHotModelStrategyKeywords(strategyResult, searchMode);
  if (manualKeywords.length === 0 && !hasUsableSearchStrategy && !warnings.some((warning) => /关键词生成|搜索策略/.test(warning))) {
    warnings.push("热点关键词不可用，本次未执行抓取；请稍后重试。");
  }
  const queryKeywords = manualKeywords.length > 0
    ? resolveSentimentHotManualQueryKeywords(submittedManualKeywords, strategyResult, searchMode)
    : resolveSentimentHotModelQueryKeywords(strategyResult, searchMode);
  warnings.push(searchMode === "normal" ? "热点抓取模式：普通（泛垂直）。" : "热点抓取模式：严格（垂直收口）。");
  if (liveOnlyRefresh) warnings.push(manualKeywords.length > 0
    ? "实时抓取：仅使用本轮账号登录态与受控回退来源，不读取或写入候选缓存、数据库候选和展示历史；搜索关键词使用本次提交的关键词。"
    : "实时抓取：仅使用本轮账号登录态与受控回退来源，不读取或写入候选缓存、数据库候选和展示历史；搜索策略由上游模型生成。");
  if (strictFreshness) {
    warnings.push(freshnessDays > 0 ? `热点新鲜度：近 ${freshnessDays} 天。` : "热点新鲜度：不限时间。");
  } else {
    warnings.push("正式抓取使用旧策略：实时来源优先，候选不足时允许缓存/历史候选轮换补足。");
  }
  if (strictFreshOnly) {
    warnings.push(liveOnlyRefresh
      ? (operationalFreshnessDays > freshnessDays
        ? `已启用严格新鲜度：优先近 ${freshnessDays} 天，缺口允许扩展至近 ${operationalFreshnessDays} 天；仅使用本轮实时候选。`
        : `已启用严格新鲜度：仅保留近 ${freshnessDays} 天实时候选。`)
      : (operationalFreshnessDays > freshnessDays
        ? `已启用严格新鲜度：优先近 ${freshnessDays} 天，缺口允许扩展至近 ${operationalFreshnessDays} 天；仅使用实时/同人设新鲜缓存，不使用过期历史补充。`
        : `已启用严格新鲜度：仅保留近 ${freshnessDays} 天内容，允许近 24 小时同人设缓存，不使用过期历史补充。`));
  }
  const poolLimit = Math.max(limit * 40, SENTIMENT_HOT_CANDIDATE_POOL_TARGET);
  const candidateSourceTarget = hasModelStrategy
    ? Math.min(poolLimit, Math.max(limit, Math.ceil(limit * 1.5)))
    : limit;
  const hasSearchKeywords = meaningfulNeedles(keywords).length > 0;
  const normalizeCandidatePool = (items: SentimentHotCandidate[]) => deferLiveSearchRelevanceGate
    ? sortUsefulHotCandidates(items, poolLimit)
    : sortSentimentHotCandidatePool(items, keywords, poolLimit, searchMode);

  const initialCacheStartedAt = Date.now();
  let candidates = hasSearchKeywords && !liveOnlyRefresh
    ? normalizeCandidatePool(readThreadsSearchCandidateCache(archiveId, keywords, poolLimit, true, searchMode, requestedPlatform))
      .filter((candidate) => candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays))
      .filter((candidate) => candidateMatchesRequestedPlatform(candidate, requestedPlatform))
    : [];
  console.info(`[sentiment_hot_stage] label=initial-cache durationMs=${Date.now() - initialCacheStartedAt}`);
  const initialCacheCount = candidates.length;
  const channelStats: string[] = [];
  const provisionalSourceStartedAt = Date.now();
  const provisionalCandidates = (await provisionalSourcePromise)
    .filter((candidate) => candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays));
  console.info(`[sentiment_hot_stage] label=provisional-source-wait durationMs=${Date.now() - provisionalSourceStartedAt}`);
  if (provisionalCandidates.length > 0) {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
    let added = 0;
    for (const candidate of provisionalCandidates) {
      const dedupeKey = sentimentCandidateDedupeKey(candidate);
      if (byId.has(candidate.id) || byKey.has(dedupeKey)) continue;
      byId.set(candidate.id, candidate);
      byKey.add(dedupeKey);
      added += 1;
    }
    candidates = normalizeCandidatePool([...byId.values()]);
    channelStats.push(`並行實時來源 ${provisionalCandidates.length}，新增 ${added}`);
  }

  if (!liveOnlyRefresh && candidates.length < candidateSourceTarget) {
    const globalPoolTerms = useModelStrategyForAcceptance && strategyResult
      ? [...sentimentHotStrategyTermsForMode(strategyResult, searchMode), ...keywords]
      : keywords;
    const globalBackfill = readGlobalThreadsCandidateBackfill(
      archiveId,
      globalPoolTerms,
      candidateSourceTarget,
      searchMode,
      requestedPlatform,
    ).filter((candidate) => (
      (!strategyResult || !useModelStrategyForAcceptance
        || candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode))
      && !isGarbageOrUselessSentimentContent(candidate.content)
      && !isCompletelyUnrelatedSentimentContent(candidate, keywords, searchMode)
    ));
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
    let added = 0;
    for (const candidate of globalBackfill) {
      const dedupeKey = sentimentCandidateDedupeKey(candidate);
      if (byId.has(candidate.id) || byKey.has(dedupeKey)) continue;
      byId.set(candidate.id, candidate);
      byKey.add(dedupeKey);
      added += 1;
    }
    if (added > 0) {
      candidates = normalizeCandidatePool([...byId.values()]);
      channelStats.push(`旧机共享候选池补充 ${added}`);
    }
  }

  if (hasSearchKeywords && args.refresh === true && !liveOnlyRefresh && candidates.length < limit) {
    candidates = await fillSentimentHotCandidatesToLimit({
      archiveId,
      keywords,
      candidates,
      limit,
      refresh: true,
      searchMode,
      freshnessDays: operationalFreshnessDays,
      platform: requestedPlatform,
      warnings,
    });
    candidates = candidates.slice(0, poolLimit);
  }

  const cachedReadyCount = hasSearchKeywords
    ? (useModelStrategyForAcceptance && strategyResult
      ? candidates.filter((candidate) => candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode)).length
      : sortRelevantHotCandidates(candidates, keywords, poolLimit, searchMode).length)
    : 0;
  const shouldFetchLiveCandidates = hasSearchKeywords
    && (args.refresh === true || candidates.length < candidateSourceTarget || cachedReadyCount < candidateSourceTarget);
  const fetchThreadsLive = liveFetchTargets.threads;
  const fetchInstagramLive = liveFetchTargets.instagram;
  if (hasSearchKeywords && args.refresh === true && candidates.length >= limit && cachedReadyCount < candidateSourceTarget) {
    warnings.push(`當前相關候選不足，已繼續補充實時來源。`);
  }
  let instagramReaderCandidatesPromise: Promise<SentimentHotCandidate[]> | null = null;
  let instagramQueries: string[] = [];
  const startInstagramReaderCandidates = (): Promise<SentimentHotCandidate[]> => {
    instagramQueries = buildInstagramHotSearchQueries(queryKeywords, keywords);
    return withSentimentTimeout(
      fetchInstagramReaderSearchCandidates({
        archiveId,
        keywords,
        queries: instagramQueries.slice(0, INSTAGRAM_READER_QUERY_LIMIT),
        limit: poolLimit,
        refresh: args.refresh === true,
        freshnessDays: strictFreshOnly ? operationalFreshnessDays : undefined,
        searchMode: strictFreshOnly ? searchMode : undefined,
        warnings,
      }),
      Math.min(INSTAGRAM_READER_STAGE_TIMEOUT_MS, remainingSentimentHotTotalBudgetMs(startedAt, 4_000, totalTimeoutMs)),
      [],
    ).catch((error) => {
      warnings.push("Instagram reader \u6293\u53d6\u5931\u6557\uff1a" + (error instanceof Error ? error.message : String(error)));
      return [];
    });
  };
  if (shouldFetchLiveCandidates && fetchInstagramLive && !SENTIMENT_HOT_READER_SERIAL_PLATFORMS) {
    instagramReaderCandidatesPromise = startInstagramReaderCandidates();
  }
  let liveThreadsCandidateCount = 0;
  if (shouldFetchLiveCandidates && fetchThreadsLive) {
    const beforeThreadsCount = candidates.length;
    const liveDeficit = Math.max(1, candidateSourceTarget - cachedReadyCount);
    const liveCollectionLimit = Math.min(
      poolLimit,
      Math.max(candidateSourceTarget, Math.min(limit * 4, Math.max(liveDeficit * 3, 30))),
    );
    const authenticatedOnly = args.sourcePolicy === "authenticated_only";
    const threadsTimeoutMs = Math.min(
      args.sourcePolicy === "reader_only" ? SENTIMENT_HOT_READER_ONLY_TOTAL_TIMEOUT_MS : SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS,
      remainingSentimentHotTotalBudgetMs(startedAt, authenticatedOnly ? 1_000 : 1_000, totalTimeoutMs),
    );
    let threadsCandidates = await measureSentimentStage(
      warnings,
      "threads-search",
      () => withSentimentTimeout(
        fetchThreadsSearchPageCandidates({
          archiveId,
          keywords,
          queryKeywords,
          limit: liveCollectionLimit,
          refresh: args.refresh === true,
          freshnessDays: operationalFreshnessDays,
          allowCacheFallback: !liveOnlyRefresh,
          ignoreHistory: liveOnlyRefresh,
          // Cache only after the final persona/relevance gates below. Raw
          // search rows can match a broad query without being valid pool data.
          writeCache: false,
          searchMode,
          deadlineAt: Date.now() + threadsTimeoutMs - (authenticatedOnly ? 500 : 1_000),
          warnings,
          sourcePolicy: args.sourcePolicy,
          deferRelevanceGate: deferLiveSearchRelevanceGate,
        }),
        threadsTimeoutMs,
        [],
      ),
    ).catch((error) => {
      warnings.push("Threads 登录态/受控回退抓取失败：" + (error instanceof Error ? error.message : String(error)));
      return [];
    });
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
    const mergeThreadsCandidates = (items: SentimentHotCandidate[]) => {
      for (const candidate of items) {
        if (!candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays)) continue;
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
          byId.set(candidate.id, candidate);
          byKey.add(dedupeKey);
        }
      }
    };
    mergeThreadsCandidates(threadsCandidates);
    candidates = normalizeCandidatePool([...byId.values()]);
    channelStats.push(`Threads 原始 ${threadsCandidates.length}，新增 ${Math.max(0, candidates.length - beforeThreadsCount)}`);

    // One request consumes one controller-issued keyword batch. Never rotate
    // this batch back through Threads; the next request receives only the
    // unconsumed model keywords from the new-host controller.
    // Interactive collection consumes the already-running Instagram result.
    // Conservative refill starts Instagram only after Threads and only when the
    // relevant candidate target is still short.
    if (
      SENTIMENT_HOT_READER_SERIAL_PLATFORMS
      && fetchInstagramLive
      && candidates.length < candidateSourceTarget
    ) {
      instagramReaderCandidatesPromise = startInstagramReaderCandidates();
    }
    if (instagramReaderCandidatesPromise && instagramQueries.length > 0 && hasSentimentHotTotalBudget(startedAt, 4_000, totalTimeoutMs)) {
      const instagramTimeoutMs = Math.min(INSTAGRAM_READER_STAGE_TIMEOUT_MS, remainingSentimentHotTotalBudgetMs(startedAt, 4_000, totalTimeoutMs));
      if (instagramTimeoutMs >= 4_000) {
        const beforeInstagramCount = candidates.length;
        const readerCandidates = await measureSentimentStage(
          warnings,
          "instagram-search",
          () => instagramReaderCandidatesPromise || Promise.resolve([]),
        );
        instagramReaderCandidatesPromise = null;
        let instagramAddedCount = 0;
        const instagramCandidates = readerCandidates;
        if (instagramCandidates.length > 0) {
          const byIdInstagram = new Map(candidates.map((candidate) => [candidate.id, candidate]));
          const byKeyInstagram = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
          for (const candidate of instagramCandidates) {
            if (!candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays)) continue;
            if (useModelStrategyForAcceptance && strategyResult && !candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode)) continue;
            const dedupeKey = sentimentCandidateDedupeKey(candidate);
            if (!byIdInstagram.has(candidate.id) && !byKeyInstagram.has(dedupeKey)) {
              byIdInstagram.set(candidate.id, candidate);
              byKeyInstagram.add(dedupeKey);
              instagramAddedCount += 1;
            }
            if (byIdInstagram.size >= poolLimit) break;
          }
          candidates = normalizeCandidatePool([...byIdInstagram.values()]);
        }
        channelStats.push(`Instagram 公开页原始 ${readerCandidates.length}，新增 ${instagramAddedCount}，补充前 ${beforeInstagramCount}`);
        if (instagramAddedCount > 0) warnings.push(`已从 Instagram 公开页加入 ${instagramAddedCount} 篇合格候选。`);
      }
    }
    instagramReaderCandidatesPromise = null;
    liveThreadsCandidateCount = threadsCandidates.length;
  }
  if (candidates.length > 0) {
    warnings.push(shouldFetchLiveCandidates
      ? (liveThreadsCandidateCount > 0
        ? (args.refresh ? "已刷新账号池实时热点候选。" : "已通过账号池实时抓取热点候选。")
        : "已检查账号登录态与受控回退来源，本轮无新增合格候选，已保留当前人设候选池。")
      : "已從當前人設候選池刷新熱點。");
  }

  if (hasSearchKeywords && shouldFetchLiveCandidates && !liveOnlyRefresh && candidates.length < limit) {
    candidates = await fillSentimentHotCandidatesToLimit({
      archiveId,
      keywords,
      candidates,
      limit,
      refresh: args.refresh === true,
      searchMode,
      freshnessDays: operationalFreshnessDays,
      platform: requestedPlatform,
      warnings,
    });
    candidates = candidates.slice(0, Math.max(limit * 40, SENTIMENT_HOT_CANDIDATE_POOL_TARGET));
  }

  if (shouldFetchLiveCandidates && instagramReaderCandidatesPromise) {
    const beforeInstagramCount = candidates.length;
    const readerCandidates = await measureSentimentStage(
      warnings,
      "instagram-parallel-search",
      () => instagramReaderCandidatesPromise || Promise.resolve([]),
    );
    let instagramAddedCount = 0;
    const instagramCandidates = readerCandidates;
    if (instagramCandidates.length > 0) {
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
      for (const candidate of instagramCandidates) {
        if (!candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays)) continue;
        if (useModelStrategyForAcceptance && strategyResult && !candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode)) continue;
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
          byId.set(candidate.id, candidate);
          byKey.add(dedupeKey);
          instagramAddedCount += 1;
        }
        if (byId.size >= poolLimit) break;
      }
      candidates = normalizeCandidatePool([...byId.values()]);
      warnings.push(`已从 Instagram 公开页加入 ${instagramAddedCount} 篇候选。`);
    }
    channelStats.push(`Instagram 公开页原始 ${readerCandidates.length}，新增 ${instagramAddedCount}，补充前 ${beforeInstagramCount}`);
  }

  // Hot candidates are deliberately collected from public pages only. Account
  // sessions, Cookie refresh and the authorized browser scanner belong to the
  // login/publish automation path and must not gate hotspot discovery.
  const cookieStatuses: SentimentCookieStatus[] = [];

  if (!liveOnlyRefresh && hasSearchKeywords && candidates.length < limit) {
    const beforeDatabaseCount = candidates.length;
    const databaseCandidates = await readCandidatesFromDatabase({ archiveId, keywords, limit: poolLimit, excludeShown: args.refresh === true });
    let databaseAddedCount = 0;
    if (databaseCandidates.length > 0) {
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
      for (const candidate of databaseCandidates) {
        if (!candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays)) continue;
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
          byId.set(candidate.id, candidate);
          byKey.add(dedupeKey);
          databaseAddedCount += 1;
        }
        if (byId.size >= poolLimit) break;
      }
      candidates = normalizeCandidatePool([...byId.values()]);
    }
    channelStats.push(`資料庫原始 ${databaseCandidates.length}，新增 ${databaseAddedCount}，補充前 ${beforeDatabaseCount}`);
  }
  if (!hasSearchKeywords) {
    warnings.push("\u7576\u524d\u4eba\u8a2d\u6c92\u6709\u89e3\u6790\u51fa\u53ef\u641c\u7d22\u95dc\u9375\u8a5e\uff0c\u5df2\u505c\u6b62\u6cdb\u5316\u641c\u7d22\uff1b\u8acb\u5148\u5728\u4eba\u8a2d\u7c21\u4ecb\u88dc\u5145\u660e\u78ba\u7684\u9818\u57df\u3001\u8208\u8da3\u6216\u8077\u696d\u8a2d\u5b9a\u3002");
  } else if (!liveOnlyRefresh && candidates.length < limit) {
    candidates = await fillSentimentHotCandidatesToLimit({
      archiveId,
      keywords,
      candidates,
      limit,
      refresh: args.refresh === true,
      searchMode,
      freshnessDays: operationalFreshnessDays,
      platform: requestedPlatform,
      warnings,
    });
    candidates = candidates.slice(0, Math.max(limit * 40, SENTIMENT_HOT_CANDIDATE_POOL_TARGET));
  }
  if (candidates.length < limit && !hasSentimentHotTotalBudget(startedAt, 1_000, totalTimeoutMs)) {
    pushSentimentHotWarning(warnings, SENTIMENT_HOT_TIMEOUT_WARNING);
  }

  let modelParentCandidatePool: SentimentHotCandidate[] = [];
  let parentSupplementCount = 0;
  if (useModelStrategyForAcceptance && strategyResult) {
    const strategyCandidatePool = candidates;
    modelParentCandidatePool = strategyCandidatePool.filter((candidate) => candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode));
    // Keep the objectively-qualified pool intact. Keyword search results are
    // not sent through a second whole-content model selection pass.
    candidates = strategyCandidatePool;
  }
  const displayCandidatePool = strictFreshOnly
    ? candidates.filter((candidate) => (
      !isHistoricalSupplementCandidate(candidate)
      || candidateMatchesOperationalFreshness(candidate, operationalFreshnessDays)
    ))
    : candidates;
  if (!liveOnlyRefresh && hasSearchKeywords && displayCandidatePool.length > 0) {
    // The candidate pool is persona-scoped. Persist only candidates that have
    // already passed the current persona strategy and freshness gates.
    writeThreadsSearchCandidateCache(archiveId, keywords, displayCandidatePool, searchMode);
    writeGlobalSentimentHotCandidatePool(displayCandidatePool);
  }
  candidates = finalizeSentimentHotCandidatesForDisplay(displayCandidatePool, limit, { archiveId: liveOnlyRefresh ? undefined : archiveId, keywords, excludeShown: !liveOnlyRefresh, searchMode, freshnessDays: operationalFreshnessDays });
  const originCounts = { live_spider: 0, search_cache: 0, candidate_pool: 0, database: 0 };
  for (const candidate of candidates) {
    originCounts[resolveSentimentHotCandidateOrigin(candidate)] += 1;
  }
  warnings.push(
    `来源区分：实时 Spider ${originCounts.live_spider}，搜索缓存 ${originCounts.search_cache}，候选池回补 ${originCounts.candidate_pool}，资料库回补 ${originCounts.database}。`,
  );
  const shownHistoryKeys = liveOnlyRefresh ? new Set<string>() : getSentimentHotShownHistoryKeys(archiveId);
  if (!liveOnlyRefresh && candidates.length < limit) {
    const selectedKeys = new Set(candidates.flatMap((candidate) => getSentimentHotCandidateHistoryKeys(candidate)));
    const supplementLimit = limit - candidates.length;
    // Re-open the same-persona cache/database for the shortage path. Refresh
    // searches exclude shown IDs while collecting live results; if the fresh
    // pool is still short, compliant same-persona rows may rotate back in
    // under the cooldown policy instead of collapsing the result count.
    const archiveHistory = [
      ...readThreadsSearchCandidateCache(archiveId, keywords, poolLimit, false, searchMode, requestedPlatform),
      ...(await readCandidatesFromDatabase({
        archiveId,
        keywords,
       limit: poolLimit,
       excludeShown: false,
     }).catch(() => [])),
    ].filter((candidate) => !useModelStrategyForAcceptance || !strategyResult || candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode));
    const orderedSupplements = orderSentimentHotCandidatesForLegacyFallback(
      finalizeSentimentHotCandidatesForDisplay([...displayCandidatePool, ...archiveHistory], poolLimit, {
        archiveId,
        keywords,
        excludeShown: false,
        searchMode,
        freshnessDays: operationalFreshnessDays,
      }),
      archiveId,
      strictFreshOnly ? { allowShownRepeat: true } : undefined,
    );
    const supplements = collectSentimentHotSupplementCandidates({
      ordered: orderedSupplements,
      archiveId,
      selectedKeys,
      limit: supplementLimit,
      strictFreshOnly,
      freshnessDays: operationalFreshnessDays,
      keywords,
    });
    if (supplements.length > 0) {
      candidates = [...candidates, ...supplements];
      const rotated = supplements.filter((candidate) => getSentimentHotCandidateHistoryKeys(candidate).some((key) => shownHistoryKeys.has(key))).length;
      warnings.push(rotated > 0
        ? `候選池不足，已補充 ${rotated} 篇符合條件的候選。`
        : `候選池不足，已補充 ${supplements.length} 篇符合條件的同人設候選。`);
    }
  }
  if (!liveOnlyRefresh && candidates.length < limit && modelParentCandidatePool.length > 0) {
    const selectedKeys = new Set(candidates.flatMap((candidate) => getSentimentHotCandidateHistoryKeys(candidate)));
    const orderedParentSupplements = orderSentimentHotCandidatesForLegacyFallback(
      finalizeSentimentHotCandidatesForDisplay(modelParentCandidatePool, poolLimit, {
        archiveId,
        keywords,
        excludeShown: false,
        searchMode,
        freshnessDays: operationalFreshnessDays,
      }),
      archiveId,
      strictFreshOnly ? { allowShownRepeat: true } : undefined,
    );
    const parentSupplements = collectSentimentHotSupplementCandidates({
      ordered: orderedParentSupplements,
      archiveId,
      selectedKeys,
      limit: searchMode === "strict"
        ? Math.min(limit - candidates.length, SENTIMENT_HOT_STRICT_PARENT_SUPPLEMENT_LIMIT - parentSupplementCount)
        : limit - candidates.length,
      strictFreshOnly,
      freshnessDays: operationalFreshnessDays,
      keywords,
    });
    if (parentSupplements.length > 0) {
      candidates = [...candidates, ...parentSupplements];
      parentSupplementCount += parentSupplements.length;
      warnings.push(`最终去重后已用模型直接父领域候选补充 ${parentSupplements.length} 篇。`);
    }
  }
  if (!liveOnlyRefresh && strictFreshOnly && candidates.length < limit) {
    // The current 7-day pool can be smaller than the requested display count
    // even after both search rounds. As a last resort, rotate compliant recent
    // same-persona history. Never cross the bounded freshness window just to
    // fill the requested count.
    const emergencyKeywords = useModelStrategyForAcceptance && strategyResult
      ? sentimentHotStrategyTermsForMode(strategyResult, searchMode)
      : keywords;
    const emergencyHistory = [
      ...readThreadsSearchCandidateCache(archiveId, emergencyKeywords, poolLimit, false, searchMode, requestedPlatform),
      ...readThreadsSearchCandidateCache(archiveId, keywords, poolLimit, false, searchMode, requestedPlatform),
      ...(await readCandidatesFromDatabase({
        archiveId,
        keywords: emergencyKeywords,
        limit: poolLimit,
        excludeShown: false,
      }).catch(() => [])),
    ];
    const scopedEmergencyHistory = useModelStrategyForAcceptance && strategyResult
      ? emergencyHistory.filter((candidate) => candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategyResult, searchMode))
      : emergencyHistory;
    const emergencyPool = finalizeSentimentHotCandidatesForDisplay(scopedEmergencyHistory, poolLimit, {
      archiveId,
      keywords: emergencyKeywords,
      excludeShown: false,
      searchMode,
      freshnessDays: operationalFreshnessDays,
    });
    const emergencySupplements = collectSentimentHotSupplementCandidates({
      ordered: orderSentimentHotCandidatesForLegacyFallback(emergencyPool, archiveId, { allowShownRepeat: true }),
      archiveId,
      selectedKeys: new Set(candidates.flatMap((candidate) => getSentimentHotCandidateHistoryKeys(candidate))),
      limit: limit - candidates.length,
      strictFreshOnly: true,
      freshnessDays: operationalFreshnessDays,
      keywords: emergencyKeywords,
    });
    if (emergencySupplements.length > 0) {
      candidates = [...candidates, ...emergencySupplements];
      channelStats.push(`近 ${operationalFreshnessDays} 天候选轮换补充 ${emergencySupplements.length}`);
      warnings.push(`近 ${freshnessDays || operationalFreshnessDays} 天新候选不足，已在近 ${operationalFreshnessDays} 天范围内按同人设合规候选轮换补足。`);
    }
  }
  const forceDetailRefresh = false;
  const detailTargetCount = args.refresh === true ? 0 : candidates.filter((candidate) => (
    candidate.platform === "threads"
    && (
      forceDetailRefresh
      || (
        typeof candidate.engagement?.viewCount !== "number"
        && typeof (candidate.metrics as any)?.view_count !== "number"
        && typeof (candidate.metrics as any)?.viewCount !== "number"
        && typeof (candidate.metrics as any)?.views !== "number"
      )
    )
  )).length;
  // Post-detail reads enrich existing candidates with view counts. They must
  // never extend the user-facing fetch beyond its total budget: each detail
  // read can open additional browser and Reader requests, while candidates are
  // already ready to return at this point.
  const detailBudgetMs = remainingSentimentHotTotalBudgetMs(startedAt, 3_000, totalTimeoutMs);
  if (detailTargetCount > 0 && detailBudgetMs >= 4_000) {
    const detailStartedAt = Date.now();
    candidates = await measureSentimentStage(
      warnings,
      "post-detail-enrichment",
      () => withSentimentTimeout(
        enrichThreadsCandidateDetails(candidates, { force: forceDetailRefresh }),
        detailBudgetMs,
        candidates,
      ),
    );
    const resolvedViewCount = candidates.filter((candidate) => (
      typeof candidate.engagement?.viewCount === "number"
      || typeof (candidate.metrics as any)?.view_count === "number"
      || typeof (candidate.metrics as any)?.viewCount === "number"
      || typeof (candidate.metrics as any)?.views === "number"
    )).length;
    channelStats.push(`原帖浏览 ${resolvedViewCount}/${candidates.length}，耗时 ${Date.now() - detailStartedAt}ms`);
    if (resolvedViewCount < candidates.length) {
      warnings.push(`已从原帖详情获取 ${resolvedViewCount}/${candidates.length} 条真实浏览量；其余原帖暂未公开或详情读取失败。`);
    }
  } else if (detailTargetCount > 0) {
    channelStats.push("原帖详情指标跳过（已优先返回热点候选）");
  }
  if (requestedPlatform) {
    candidates = candidates.filter((candidate) => candidateMatchesRequestedPlatform(candidate, requestedPlatform));
    warnings.push(requestedPlatform === "instagram" ? "本次仅抓取 Instagram。" : "本次仅抓取 Threads。");
  }
  const finalThreadsCount = candidates.filter((candidate) => candidate.platform === "threads").length;
  const finalInstagramCount = candidates.filter((candidate) => candidate.platform === "instagram").length;
  channelStats.push(`最終來源 Threads ${finalThreadsCount}，Instagram ${finalInstagramCount}`);
  const channelSummary = [
    `快取初始 ${initialCacheCount}`,
    ...channelStats,
    `最終 ${candidates.length}/${limit}`,
  ].join("；");
  console.info(`[sentiment_hot_channels] archiveId=${archiveId} ${channelSummary}`);
  warnings.push(`渠道統計：${channelSummary}`);

  if (candidates.length === 0) {
    warnings.push("\u672a\u627e\u5230\u7b26\u5408\u689d\u4ef6\u7684\u9ad8\u71b1\u5ea6\u4e2d\u6587\u71b1\u9ede\uff1b\u8acb\u5237\u65b0\u6216\u63db\u66f4\u4eba\u8a2d\u95dc\u9375\u8a5e\u3002");
  } else if (candidates.length < limit) {
    warnings.push(`\u672c\u6b21\u53ea\u627e\u5230\u0020${candidates.length}/${limit}\u0020\u7bc7\u9ad8\u71b1\u5ea6\u4e2d\u6587\u71b1\u9ede\uff0c\u5df2\u904e\u6ffe\u91cd\u8907\u3001\u975e\u4e2d\u6587\u6216\u4f4e\u71b1\u5ea6\u5167\u5bb9\u3002`);
  }
  if (candidates.length > 0 && !liveOnlyRefresh && args.recordShown !== false) {
    try {
      rememberSentimentHotShown(archiveId, candidates);
    } catch (error) {
      warnings.push(`热点展示历史记录失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { candidates, keywords, searchMode, freshnessDays, freshnessPolicy, cookieStatuses, warnings };
}

export async function fetchSentimentHotCandidates(args: {
  archive?: PersonaArchive;
  prompt?: string;
  writingLocale?: string;
  limit?: number;
  refresh?: boolean;
  searchMode?: SentimentHotSearchMode;
  freshnessDays?: number;
  freshnessPolicy?: SentimentHotFreshnessPolicy;
  recordShown?: boolean;
  liveOnly?: boolean;
  sourcePolicy?: "reader_first" | "reader_only" | "authenticated_only";
  keywords?: string[];
  platform?: SentimentHotPlatform | string;
}): Promise<FetchSentimentHotCandidatesResult> {
  const archiveId = cleanText(args.archive?.id) || "default";
  const searchMode = normalizeSentimentHotSearchMode(args.searchMode);
  return withSentimentHotExecutionLock(`${searchMode}:${archiveId}`, () => fetchSentimentHotCandidatesUnlocked(args));
}

async function fillSentimentHotCandidatesToLimit(args: {
  archiveId: string;
  keywords: string[];
  candidates: SentimentHotCandidate[];
  limit: number;
  refresh?: boolean;
  searchMode?: SentimentHotSearchMode;
  platform?: SentimentHotPlatform;
  freshnessDays?: number;
  warnings: string[];
}): Promise<SentimentHotCandidate[]> {
  const out: SentimentHotCandidate[] = [];
  const seen = new Set<string>();
  const seenDedupeKeys = new Set<string>();
  const shownHistoryKeys = args.refresh === true ? getSentimentHotShownHistoryKeys(args.archiveId) : new Set<string>();
  const add = (candidate: SentimentHotCandidate, qualityKeywords = args.keywords, qualityMode: SentimentHotSearchMode = normalizeSentimentHotSearchMode(args.searchMode)) => {
    const content = cleanSentimentCandidateContent(candidate.content || "");
    if (!candidate?.id || seen.has(candidate.id)) return;
    if (args.refresh === true && getSentimentHotCandidateHistoryKeys({ ...candidate, content }).some((key) => shownHistoryKeys.has(key))) return;
    const dedupeKey = sentimentCandidateDedupeKey(candidate, content);
    if (seenDedupeKeys.has(dedupeKey)) return;
    if (args.platform && !candidateMatchesRequestedPlatform(candidate, args.platform)) return;
    const normalized = candidateMeetsDisplayQuality({ ...candidate, content }, qualityKeywords, qualityMode, args.freshnessDays);
    if (!normalized) return;
    seen.add(normalized.id);
    seenDedupeKeys.add(dedupeKey);
    out.push(normalized);
  };

  for (const candidate of args.candidates) add(candidate);
  if (out.length >= args.limit) return out.slice(0, args.limit);

  const fallbackCandidates = [
    ...readThreadsSearchCandidateCache(args.archiveId, args.keywords, Math.max(args.limit * 20, SENTIMENT_HOT_CANDIDATE_POOL_TARGET), true, args.searchMode, args.platform),
    ...(await readCandidatesFromDatabase({
      archiveId: args.archiveId,
      keywords: args.keywords,
      limit: Math.max(args.limit * 20, SENTIMENT_HOT_CANDIDATE_POOL_TARGET),
      excludeShown: args.refresh === true,
    }).catch(() => [])),
  ];
  for (const candidate of fallbackCandidates) {
    add(candidate);
    if (out.length >= args.limit) break;
  }

  if (out.length < args.limit) {
    const beforeArchiveBackfillCount = out.length;
    const archiveBackfillCandidates = readArchiveScopedThreadsCandidateBackfill(
      args.archiveId,
      args.keywords,
      Math.max(args.limit * 30, SENTIMENT_HOT_CANDIDATE_POOL_TARGET),
      args.refresh === true,
      args.searchMode,
    );
    for (const candidate of archiveBackfillCandidates) {
      add(candidate);
      if (out.length >= args.limit) break;
    }
    if (out.length > beforeArchiveBackfillCount) {
      args.warnings.push(`即時新候選不足，已用同一人設歷史關鍵詞候選回補到 ${out.length}/${args.limit} 篇。`);
    }
  }

  if (out.length >= args.limit) {
    if (args.refresh === true) {
      args.warnings.push("即時新結果不足 " + args.limit + " 篇，已只使用同人設未展示且符合當前模式的近期候選補足。");
    } else {
      args.warnings.push("\u5373\u6642\u65b0\u7d50\u679c\u4e0d\u8db3\u0020" + args.limit + "\u0020\u7bc7\uff0c\u5df2\u7528\u540c\u4eba\u8a2d\u95dc\u9375\u8a5e\u7684\u9ad8\u71b1\u5ea6\u6b77\u53f2\u5019\u9078\u88dc\u9f4a\u3002");
    }
    return out;
  }

  return out;
}

export function isObviouslyLowQualitySentimentHotCandidate(candidate: SentimentHotCandidate, keywords: string[] = []): boolean {
  const content = cleanSentimentCandidateContent(candidate.content);
  if (!content || isLowQualitySentimentContent(content) || isGarbageOrUselessSentimentContent(content)) return true;
  if (!isChineseSentimentCandidate(content)) return true;
  const hanCount = sentimentHotHanCount(content);
  if (/threads\s*(?:log\s*in|login)|join threads|log in with instagram|page is gone|not all who wander are lost/i.test(content)) return true;
  if (/^\s*(?:https?:\/\/|www\.)/i.test(content) && hanCount < 40) return true;
  if (hanCount < MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT) return true;
  if (hanCount < 40 && /(?:私訊|私信).*(?:下單|下单|購買|购买|領券|领券)/u.test(content)) return true;
  if (/(.)\1{8,}/u.test(content)) return true;
  if (
    keywords.length > 0
    && !candidateHasCurrentKeywordSearchEvidence(candidate, keywords)
    && !candidateMatchesCurrentKeywords({ ...candidate, content }, keywords)
  ) return true;
  return false;
}

async function withSentimentTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingSentimentHotTotalBudgetMs(
  startedAt: number,
  reserveMs = 0,
  totalTimeoutMs = SENTIMENT_HOT_TOTAL_TIMEOUT_MS,
): number {
  return Math.max(1_000, totalTimeoutMs - (Date.now() - startedAt) - reserveMs);
}

function hasSentimentHotTotalBudget(
  startedAt: number,
  minRemainingMs = 1_000,
  totalTimeoutMs = SENTIMENT_HOT_TOTAL_TIMEOUT_MS,
): boolean {
  return totalTimeoutMs - (Date.now() - startedAt) >= minRemainingMs;
}

function pushSentimentHotWarning(warnings: string[], warning: string) {
  if (!warnings.includes(warning)) warnings.push(warning);
}

async function measureSentimentStage<T>(warnings: string[], label: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    console.info(`[sentiment_hot_stage] label=${label} durationMs=${elapsedMs}`);
  }
}

function remainingSentimentDeadlineMs(deadlineAt?: number, fallbackMs = 1_000): number {
  if (!deadlineAt) return fallbackMs;
  return Math.max(1, deadlineAt - Date.now());
}

async function syncSentimentKeywords(keywords: string[]) {
  const usableKeywords = meaningfulNeedles(keywords).slice(0, 6);
  for (const keyword of usableKeywords) {
    const response = await fetch(`${resolveSentimentBackendUrl()}/api/sentiment/keywords`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword }),
      signal: buildAbortSignalTimeout(5_000),
    });
    if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
  }
}

function buildSentimentRefreshQueryPool(baseQueries: string[]): string[] {
  const dynamicQueries = buildDynamicSearchQueryVariants(baseQueries);
  return [...new Set((dynamicQueries.length ? dynamicQueries : baseQueries).map(cleanText).filter(Boolean))];
}

function rotateSentimentQueries(queries: string[], seed: number): string[] {
  if (queries.length <= 1) return queries;
  const offset = Math.abs(seed) % queries.length;
  return [...queries.slice(offset), ...queries.slice(0, offset)];
}

function buildOrderedSentimentQueries(baseQueries: string[], seed: number, refresh = false): string[] {
  const pool = buildSentimentRefreshQueryPool(baseQueries);
  const baseSet = new Set(baseQueries);
  const supplemental = pool.filter((query) => !baseSet.has(query));
  // On refresh, rotate the base window itself. Previously only supplemental
  // variants were rotated after the base list, but the browser/Reader stages
  // slice the first 36/24 queries, so repeated refreshes kept searching the
  // same keywords and never reached the rotated variants.
  const orderedBase = refresh ? rotateSentimentQueries(baseQueries, seed) : baseQueries;
  return [...orderedBase, ...rotateSentimentQueries(supplemental, refresh ? seed : 0)];
}

function buildDynamicSearchQueryVariants(baseQueries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string, options?: { maxLength?: number }) => {
    const text = cleanText(value)
      .replace(/[「」『』“”"'()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || !hasHan(text)) return;
    if (text.length < 2 || text.length > (options?.maxLength || 14)) return;
    const key = text.toLowerCase();
    if (isGenericSentimentKeyword(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  const addSplitParts = (value: string) => {
    const text = cleanText(value);
    for (const part of text.split(/\s+|和|與|与|及|以及|跟|、|，|,|\/|／|-|_|\+|&/g)) add(part);
    const hanRuns = text.match(/[\u3400-\u9fff]{2,}/gu) || [];
    for (const run of hanRuns) {
      add(run);
      for (const word of segmentPersonaWords(run)) add(word);
    }
  };

  for (const query of baseQueries) {
    add(query);
    for (const variant of expandSentimentSearchKeywordVariants(query)) add(variant);
    addSplitParts(query);
  }
  return out.slice(0, 120);
}

function buildRelevanceNeedles(keywords: string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const keyword = cleanText(value);
    if (!keyword || !isSearchableRelevanceTerm(keyword)) return;
    if (keyword.length < 2 || keyword.length > 14) return;
    const key = keyword.toLowerCase();
    if (isGenericSentimentKeyword(key)) return;
    if (WEAK_RELEVANCE_STOPWORDS.has(keyword)) return;
    if (!out.some((item) => item.toLowerCase() === key)) out.push(keyword);
  };
  const addDerived = (value: string) => {
    const keyword = cleanText(value);
    if (keyword.length < 3) return;
    add(keyword);
  };
  for (const keyword of meaningfulNeedles(keywords).filter(isSearchableRelevanceTerm)) {
    add(keyword);
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
    for (const part of splitKeywords(keyword)) addDerived(part);
    const runs = keyword.match(/[\u3400-\u9fff]{2,}/gu) || [];
    for (const run of runs) {
      addDerived(run);
      for (const word of segmentPersonaWords(run)) addDerived(word);
    }
  }
  return out
    .filter((keyword) => {
      const key = keyword.toLowerCase();
      if (keyword.length < 2 || keyword.length > 14) return false;
      if (isGenericSentimentKeyword(key)) return false;
      if (WEAK_RELEVANCE_STOPWORDS.has(keyword)) return false;
      return true;
    })
    .slice(0, 96);
}

function buildStrongRelevanceNeedles(keywords: string[]): string[] {
  return buildRelevanceNeedles(keywords).filter((keyword) => !isWeakRelevanceKeyword(keyword));
}

function buildStrictRelevanceNeedles(keywords: string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const keyword = cleanText(value);
    if (!keyword || !isSearchableRelevanceTerm(keyword)) return;
    if (keyword.length < 2 || keyword.length > 14) return;
    if (isGenericSentimentKeyword(keyword.toLowerCase())) return;
    if (WEAK_RELEVANCE_STOPWORDS.has(keyword)) return;
    if (!out.some((item) => item.toLowerCase() === keyword.toLowerCase())) out.push(keyword);
  };
  const addDerived = (value: string) => {
    const keyword = cleanText(value);
    if (keyword.length < 3) return;
    add(keyword);
  };
  for (const keyword of meaningfulNeedles(keywords).filter(isSearchableRelevanceTerm)) {
    add(keyword);
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
    for (const part of splitKeywords(keyword)) addDerived(part);
    const runs = keyword.match(/[\u3400-\u9fff]{2,}/gu) || [];
    for (const run of runs) {
      addDerived(run);
      for (const word of segmentPersonaWords(run)) addDerived(word);
    }
  }
  const identityNeedleBases = meaningfulNeedles(keywords)
    .slice(0, 3)
    .flatMap((keyword) => [keyword, ...segmentPersonaWords(keyword)])
    .map((keyword) => keyword.replace(/[者師师員员]$/u, ""))
    .filter((keyword) => (
      keyword.length >= 2
      && keyword.length <= 8
      && isSearchableRelevanceTerm(keyword)
      && !isGenericSentimentKeyword(keyword.toLowerCase())
      && !isWeakRelevanceKeyword(keyword)
      && !isGenericPersonaRoleTerm(keyword)
    ))
    .slice(0, 1);
  // Strict-mode identity terms must retain both simplified and traditional
  // forms. Otherwise a model query such as 修車 can discard the equivalent
  // 修车 needle as a short substring of a longer compound keyword.
  const identityNeedles = [...new Set(identityNeedleBases.flatMap((keyword) => expandChineseScriptVariants(keyword)))];
  return out
    .filter((keyword) => (
      identityNeedles.includes(keyword)
      ||
      keyword.length >= 4
      || !out.some((other) => other !== keyword && other.length > keyword.length && other.includes(keyword))
    ))
    .slice(0, 48);
}

function buildRelevanceNeedlesForMode(keywords: string[], mode: SentimentHotSearchMode): string[] {
  return mode === "strict" ? buildStrictRelevanceNeedles(keywords) : buildRelevanceNeedles(keywords);
}

function buildStrongRelevanceNeedlesForMode(keywords: string[], mode: SentimentHotSearchMode): string[] {
  return buildRelevanceNeedlesForMode(keywords, mode).filter((keyword) => !isWeakRelevanceKeyword(keyword));
}

function buildDirectRelevanceNeedles(keywords: string[]): string[] {
  return [...new Set(meaningfulNeedles(keywords)
    .map(cleanText)
    .filter((keyword) => keyword.length >= 2 && isSearchableRelevanceTerm(keyword) && !isGenericSentimentKeyword(keyword.toLowerCase())))];
}

function isUsefulHotCandidate(candidate: SentimentHotCandidate): boolean {
  // Relevance, freshness and content-quality gates run separately. Heat has
  // one non-adaptive floor so every result follows the same rule.
  return Number(candidate.hotScore || 0) >= MIN_SENTIMENT_HOT_SCORE_FLOOR;
}

function sentimentCandidateSource(candidate: SentimentHotCandidate): string {
  return cleanText((candidate.metrics as any)?.source || "");
}

function sourceQueryBelongsToCurrentKeywordBatch(sourceQuery: string, keywords: string[]): boolean {
  const query = cleanText(sourceQuery);
  if (!query) return false;
  const currentQueries = new Set(keywords
    .flatMap((keyword) => expandChineseScriptVariants(cleanText(keyword)))
    .map(cleanText)
    .filter(Boolean));
  return [...currentQueries].some((keyword) => (
    query === keyword
    || (query.length >= 4 && keyword.includes(query))
    || (keyword.length >= 4 && query.includes(keyword))
  ));
}

function candidateHasCurrentKeywordSearchEvidence(candidate: SentimentHotCandidate, keywords: string[]): boolean {
  const source = sentimentCandidateSource(candidate);
  if (
    source !== "threads-account-search"
    && source !== "threads-reader-search"
    && source !== "threads-search-page"
    && source !== "instagram-reader-search"
    && source !== "instagram-account-search"
  ) return false;
  const sourceQuery = cleanText((candidate.metrics as any)?.query);
  if (!sourceQueryBelongsToCurrentKeywordBatch(sourceQuery, keywords)) return false;
  const matchedKeywords = (candidate.metrics as any)?.matchedKeywords;
  return Array.isArray(matchedKeywords) && matchedKeywords.some((value: unknown) => cleanText(value).length >= 2);
}

function sentimentCandidateSourceTier(candidate: SentimentHotCandidate): string {
  if (isArchiveScopedFallbackCandidate(candidate)) return "fallback_history";
  const source = sentimentCandidateSource(candidate);
  if (source === "threads-account-search" || source === "threads-reader-search" || source === "threads-search-page") return "primary_threads_search";
  if (source === "instagram-reader-search" || source === "instagram-account-search") return "supplement_instagram_search";
  return "primary_hot";
}

export type SentimentHotCandidateOrigin = "live_spider" | "search_cache" | "candidate_pool" | "database";

export function resolveSentimentHotCandidateOrigin(candidate: SentimentHotCandidate): SentimentHotCandidateOrigin {
  const metrics = (candidate?.metrics || {}) as any;
  const marked = cleanText(metrics.origin);
  if (marked === "live_spider" || marked === "search_cache" || marked === "candidate_pool" || marked === "database") {
    return marked;
  }
  if (metrics.globalPersonaBackfill || metrics.archiveScopedFallback || metrics.sourceTier === "fallback_history") {
    return "candidate_pool";
  }
  if (metrics.source === "database") return "database";
  if (metrics.liveFetch === true) return "live_spider";
  if (metrics.publicSearch === true && String(metrics.crawler || "").startsWith("spider")) return "live_spider";
  return "search_cache";
}

function stampHotCandidateOrigin(candidate: SentimentHotCandidate, origin: SentimentHotCandidateOrigin): SentimentHotCandidate {
  return {
    ...candidate,
    metrics: {
      ...(candidate.metrics || {}),
      origin,
      liveFetch: origin === "live_spider",
    },
  };
}

function sentimentHotHanCount(value: unknown): number {
  return (cleanSentimentCandidateContent(value).match(/[\u3400-\u9fff]/gu) || []).length;
}

function sentimentHotReadableCharacterCount(value: unknown): number {
  return Array.from(cleanSentimentCandidateContent(value)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, ""))
    .length;
}

function hasMinimumSentimentHotContentLength(candidate: SentimentHotCandidate): boolean {
  return sentimentHotHanCount(candidate.content) >= MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT;
}

function minimumSentimentHotHanCountForCandidate(candidate: SentimentHotCandidate): number {
  const source = sentimentCandidateSource(candidate);
  if (
    (source === "threads-account-search"
      || ((source === "threads-search-page" || source === "threads-reader-search")
        && (candidate.metrics as any)?.publicSearch === true))
    && Number(candidate.hotScore || 0) >= MIN_SENTIMENT_HOT_SCORE_FLOOR
  ) {
    // Threads search frequently returns high-engagement concise posts and
    // video captions. Keep the heat/relevance/language gates hard, but do not
    // drop a real live hotspot only because its caption is shorter than a
    // long-form draft.
    return MIN_PUBLIC_THREADS_HOT_HAN_COUNT;
  }
  return MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT;
}

function isNoisyReaderCandidateContent(candidate: SentimentHotCandidate, content: string): boolean {
  const source = sentimentCandidateSource(candidate);
  if (source !== "threads-account-search" && source !== "threads-reader-search" && source !== "threads-search-page" && source !== "instagram-reader-search" && source !== "instagram-account-search") return false;
  const raw = String(candidate.content || "");
  const text = [raw, content].join(" ");
  const hanCount = sentimentHotHanCount(content);
  const latinCount = (content.match(/[A-Za-z]/g) || []).length;
  const urlishCount = (text.match(/https?:\/\/|www\.|cdninstagram|scontent-|fbcdn|_nc_|\.jpg|\.png|\.webp|profile picture|URL Source|Markdown Content/gi) || []).length;
  if (urlishCount >= 2 && hanCount < 60) return true;
  if (latinCount > Math.max(80, hanCount * 5) && hanCount < 80) return true;
  if (source === "instagram-reader-search") {
    if (/(?:\[\[|\]\(|!\[|Image\s+\d+:|This is a case where|Markdown Content|URL Source)/i.test(text)) return true;
    if (urlishCount >= 1 && hanCount < 50) return true;
    if (/(?:cdninstagram|scontent-|fbcdn|_nc_|dst-jpg|\.jpg|\.png|\.webp|profile picture|URL Source|Markdown Content)/i.test(text) && hanCount < 80) return true;
  }
  return false;
}

function sentimentHotPublishedAtMs(candidate: SentimentHotCandidate): number | null {
  const parsed = Date.parse(String(candidate.publishedAt || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function candidateMatchesGlobalPoolRetention(
  candidate: SentimentHotCandidate,
  now = Date.now(),
): boolean {
  const publishedAt = sentimentHotPublishedAtMs(candidate);
  return publishedAt !== null && publishedAt >= now - SENTIMENT_HOT_GLOBAL_POOL_RETENTION_MS;
}

function candidateHasAcceptableFreshness(candidate: SentimentHotCandidate, freshnessDays = 0): boolean {
  const publishedAt = sentimentHotPublishedAtMs(candidate);
  if (publishedAt === null) {
    if (normalizeSentimentHotFreshnessDays(freshnessDays) > 0) return false;
    return true;
  }
  const age = Date.now() - publishedAt;
  const requestedMaxAgeMs = normalizeSentimentHotFreshnessDays(freshnessDays) * 24 * 60 * 60 * 1000;
  const maxAgeMs = requestedMaxAgeMs > 0 ? requestedMaxAgeMs : SENTIMENT_HOT_MAX_PUBLISHED_AGE_MS;
  return age >= -24 * 60 * 60 * 1000 && age <= maxAgeMs;
}

function sentimentHotFreshnessRank(candidate: SentimentHotCandidate): number {
  const publishedAt = sentimentHotPublishedAtMs(candidate);
  if (publishedAt === null) return 4;
  const age = Math.max(0, Date.now() - publishedAt);
  if (age <= 3 * 24 * 60 * 60 * 1000) return 0;
  if (age <= 7 * 24 * 60 * 60 * 1000) return 1;
  if (age <= 14 * 24 * 60 * 60 * 1000) return 2;
  return 3;
}

function compareSentimentHotFreshness(a: SentimentHotCandidate, b: SentimentHotCandidate): number {
  const rankDelta = sentimentHotFreshnessRank(a) - sentimentHotFreshnessRank(b);
  if (rankDelta !== 0) return rankDelta;
  return (sentimentHotPublishedAtMs(b) || 0) - (sentimentHotPublishedAtMs(a) || 0);
}

function compareSentimentHotPriority(a: SentimentHotCandidate, b: SentimentHotCandidate): number {
  return Number(b.hotScore || 0) - Number(a.hotScore || 0)
    || (sentimentHotPublishedAtMs(b) || 0) - (sentimentHotPublishedAtMs(a) || 0)
    || sentimentHotHanCount(b.content) - sentimentHotHanCount(a.content);
}

function isReverseSentimentHotContent(candidate: SentimentHotCandidate, keywords: string[] = []): boolean {
  const content = cleanSentimentCandidateContent(candidate.content || "");
  if (!content) return false;
  const reverse = /(?:不會再|不会再|再也不|不再(?:把錢|花錢|花钱|買|买)|以後拒絕|以后拒绝|以後不再|以后不再|戒掉|抵制|不想再買|不想再买|別再買|别再买|不要再買|不要再买)/u;
  if (!reverse.test(content)) return false;
  const objects = [...new Set(keywords.map(cleanText).filter((item) => item.length >= 2))];
  if (objects.length === 0) return true;
  return objects.some((term) => content.includes(term));
}

export function resolveSentimentHotDisplayHeatThreshold(candidates: SentimentHotCandidate[], limit: number): number {
  const requested = Math.max(1, Math.floor(limit || 1));
  for (const threshold of SENTIMENT_HOT_SCORE_FALLBACK_STEPS) {
    if (candidates.filter((candidate) => Number(candidate.hotScore || 0) >= threshold).length >= requested) {
      return threshold;
    }
  }
  return MIN_SENTIMENT_HOT_SCORE_FLOOR;
}

function candidateMeetsDisplayQuality(
  candidate: SentimentHotCandidate,
  keywords: string[] = [],
  searchMode: SentimentHotSearchMode = "normal",
  freshnessDays = 0,
  rejectionStats?: Record<string, number>,
  skipHeatGate = false,
): SentimentHotCandidate | null {
  const reject = (reason: string) => {
    if (rejectionStats) rejectionStats[reason] = (rejectionStats[reason] || 0) + 1;
    return null;
  };
  const content = cleanSentimentCandidateContent(candidate.content || "");
  if (!candidate?.id || !content) return reject("missing_content");
  if (isLowQualitySentimentContent(content) || !isChineseSentimentCandidate(content)) return reject("low_quality_or_language");
  const normalized: SentimentHotCandidate = {
    ...candidate,
    content,
    metrics: {
      ...(candidate.metrics || {}),
      sourceTier: sentimentCandidateSourceTier(candidate),
    },
  };
  if (!candidateMatchesOperationalFreshness(normalized, freshnessDays)) return reject("freshness");
  if (!skipHeatGate && !isUsefulHotCandidate(normalized)) {
    const viewCount = Number(normalized.engagement?.viewCount ?? (normalized.metrics as any)?.view_count ?? 0);
    return reject(viewCount >= MIN_SENTIMENT_HOT_SCORE_FLOOR ? "heat_interactions_only" : "heat");
  }
  if (
    sentimentHotReadableCharacterCount(content) < MIN_SENTIMENT_HOT_READABLE_CHARACTER_COUNT
    || sentimentHotHanCount(content) < minimumSentimentHotHanCountForCandidate(normalized)
  ) return reject("content_length");
  if (isNoisyReaderCandidateContent(normalized, content)) return reject("reader_noise");
  if (isGarbageOrUselessSentimentContent(content)) return reject("garbage");
  if (isReverseSentimentHotContent(normalized, keywords)) return reject("reverse_stance");
  if (isCompletelyUnrelatedSentimentContent(normalized, keywords, searchMode)) return reject("unrelated");
  return normalized;
}

function uniqueSentimentWarnings(warnings: unknown[]): string[] {
  return [...new Set(warnings.map(cleanText).filter(Boolean))];
}

function sortUsefulHotCandidates(candidates: SentimentHotCandidate[], limit: number): SentimentHotCandidate[] {
  return candidates
    .map((candidate) => candidateMeetsDisplayQuality(candidate))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate))
    .sort(compareSentimentHotPriority)
    .slice(0, limit);
}

function sortRelevantHotCandidates(candidates: SentimentHotCandidate[], keywords: string[], limit: number, searchMode: SentimentHotSearchMode = "normal"): SentimentHotCandidate[] {
  return sortUsefulHotCandidates(
    candidates.filter((candidate) => candidateMatchesCurrentKeywords(candidate, keywords, searchMode)),
    limit,
  );
}

function sortSentimentHotCandidatePool(candidates: SentimentHotCandidate[], keywords: string[], limit: number, searchMode: SentimentHotSearchMode = "normal"): SentimentHotCandidate[] {
  return candidates
    .map((candidate) => candidateMeetsDisplayQuality(candidate, keywords, searchMode))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate))
    .sort(compareSentimentHotPriority)
    .slice(0, limit);
}

export function finalizeSentimentHotCandidatesForDisplay(candidates: SentimentHotCandidate[], limit: number, options?: { archiveId?: string; keywords?: string[]; excludeShown?: boolean; searchMode?: SentimentHotSearchMode; freshnessDays?: number }): SentimentHotCandidate[] {
  const out: SentimentHotCandidate[] = [];
  const seenKeys = new Set<string>();
  const shownIds = options?.archiveId ? getSentimentHotShownIds(options.archiveId) : new Set<string>();
  const shownHistoryKeys = options?.archiveId ? getSentimentHotShownHistoryKeys(options.archiveId) : new Set<string>();
  const shownAtMap = options?.archiveId ? getSentimentHotShownAtMap(options.archiveId) : new Map<string, number>();
  const keywords = options?.keywords || [];
  const searchMode = normalizeSentimentHotSearchMode(options?.searchMode);
  const qualified = candidates
    .map((candidate) => candidateMeetsDisplayQuality(candidate, keywords, searchMode, options?.freshnessDays))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate));
  const sorted = qualified
    .sort((a, b) => {
      const priorityDelta = compareSentimentHotPriority(a, b);
      if (priorityDelta !== 0) return priorityDelta;
      const aShown = shownIds.has(a.id) ? 1 : 0;
      const bShown = shownIds.has(b.id) ? 1 : 0;
      if (aShown !== bShown) return aShown - bShown;
      if (aShown && bShown) {
        const aShownAt = shownAtMap.get(a.id) || 0;
        const bShownAt = shownAtMap.get(b.id) || 0;
        if (aShownAt !== bShownAt) return aShownAt - bShownAt;
      }
      return 0;
    });
  // There is one explicit 500-point floor. Qualified rows are sorted by
  // real engagement first, then publication time.
  for (const threshold of SENTIMENT_HOT_SCORE_FALLBACK_STEPS) {
    for (const candidate of sorted) {
      if (Number(candidate.hotScore || 0) < threshold) continue;
      const content = cleanSentimentCandidateContent(candidate.content || "");
      if (!content) continue;
      if (options?.excludeShown && getSentimentHotCandidateHistoryKeys({ ...candidate, content }).some((key) => shownHistoryKeys.has(key))) continue;
      const keys = sentimentCandidateFinalDedupeKeys(candidate, content);
      if (keys.some((key) => seenKeys.has(key))) continue;
      keys.forEach((key) => seenKeys.add(key));
      out.push({ ...candidate, content });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function ensureSentimentHotPlatformContributions(
  selected: SentimentHotCandidate[],
  pool: SentimentHotCandidate[],
  limit: number,
  options?: { archiveId?: string; keywords?: string[]; excludeShown?: boolean; searchMode?: SentimentHotSearchMode; freshnessDays?: number },
): SentimentHotCandidate[] {
  const qualifiedSelected = finalizeSentimentHotCandidatesForDisplay(selected, limit, options);
  if (limit < 2 || qualifiedSelected.length === 0) return qualifiedSelected;
  const out = qualifiedSelected.slice(0, limit);
  for (const platform of ["threads", "instagram"] as SentimentHotPlatform[]) {
    if (out.some((candidate) => candidate.platform === platform)) continue;
    const platformCandidates = finalizeSentimentHotCandidatesForDisplay(
      pool.filter((candidate) => candidate.platform === platform),
      limit,
      options,
    );
    const existingKeys = new Set(out.flatMap((candidate) => sentimentCandidateFinalDedupeKeys(
      candidate,
      cleanSentimentCandidateContent(candidate.content || ""),
    )));
    const replacement = platformCandidates.find((candidate) => sentimentCandidateFinalDedupeKeys(
      candidate,
      cleanSentimentCandidateContent(candidate.content || ""),
    ).every((key) => !existingKeys.has(key)));
    if (!replacement) continue;
    if (out.length < limit) {
      out.push(replacement);
      continue;
    }
    const platformCounts = new Map<SentimentHotPlatform, number>();
    out.forEach((candidate) => platformCounts.set(candidate.platform, (platformCounts.get(candidate.platform) || 0) + 1));
    let replaceIndex = -1;
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if ((platformCounts.get(out[index].platform) || 0) > 1) {
        replaceIndex = index;
        break;
      }
    }
    if (replaceIndex >= 0) out.splice(replaceIndex, 1, replacement);
  }
  return out;
}

function latestSentimentHotShownAt(candidate: SentimentHotCandidate, shownAtMap: Map<string, number>): number {
  return Math.max(0, ...getSentimentHotCandidateHistoryKeys(candidate).map((key) => shownAtMap.get(key) || 0));
}

function isSentimentHotCandidateRepeatEligibleWithState(
  candidate: SentimentHotCandidate,
  shownHistoryKeys: Set<string>,
  shownAtMap: Map<string, number>,
  options?: { cooldownMs?: number; now?: number },
): boolean {
  const historyKeys = getSentimentHotCandidateHistoryKeys(candidate);
  if (!historyKeys.some((key) => shownHistoryKeys.has(key))) return true;
  const shownAt = latestSentimentHotShownAt(candidate, shownAtMap);
  // Legacy string-only entries have no timestamp; treat them as eligible so a
  // migration cannot permanently starve a persona's candidate pool.
  if (!shownAt) return true;
  const now = options?.now ?? Date.now();
  const cooldownMs = Math.max(0, Number(options?.cooldownMs ?? SENTIMENT_HOT_REPEAT_COOLDOWN_MS));
  return now - shownAt >= cooldownMs;
}

export function isSentimentHotCandidateRepeatEligible(candidate: SentimentHotCandidate, archiveId: string, options?: { cooldownMs?: number; now?: number }): boolean {
  const shownHistoryKeys = getSentimentHotShownHistoryKeys(archiveId);
  return isSentimentHotCandidateRepeatEligibleWithState(
    candidate,
    shownHistoryKeys,
    getSentimentHotShownHistoryAtMap(archiveId),
    options,
  );
}

export interface SentimentHotFallbackOrderOptions {
  allowShownRepeat?: boolean;
  cooldownMs?: number;
  now?: number;
}

export function orderSentimentHotCandidatesForLegacyFallback(candidates: SentimentHotCandidate[], archiveId: string, options?: SentimentHotFallbackOrderOptions): SentimentHotCandidate[] {
  const shownHistoryKeys = getSentimentHotShownHistoryKeys(archiveId);
  const shownAtMap = getSentimentHotShownHistoryAtMap(archiveId);
  const allowShownRepeat = options?.allowShownRepeat === true;
  const now = options?.now ?? Date.now();
  const cooldownMs = Math.max(0, Number(options?.cooldownMs ?? SENTIMENT_HOT_REPEAT_COOLDOWN_MS));
  const rotationBucket = Math.floor(now / SENTIMENT_HOT_REPEAT_ROTATION_BUCKET_MS);
  const shownAt = (candidate: SentimentHotCandidate) => {
    const values = getSentimentHotCandidateHistoryKeys(candidate)
      .map((key) => shownAtMap.get(key))
      .filter((value): value is number => typeof value === "number");
    return values.length ? Math.max(...values) : 0;
  };
  const isShown = (candidate: SentimentHotCandidate) => getSentimentHotCandidateHistoryKeys(candidate)
    .some((key) => shownHistoryKeys.has(key));
  const isCooldownEligible = (candidate: SentimentHotCandidate) => isSentimentHotCandidateRepeatEligibleWithState(
    candidate,
    shownHistoryKeys,
    shownAtMap,
    { cooldownMs, now },
  );
  const rotationKey = (candidate: SentimentHotCandidate) => crypto
    .createHash("sha1")
    .update(`${candidate.id}:${rotationBucket}`)
    .digest("hex");
  const unique: SentimentHotCandidate[] = [];
  const sorted = [...candidates].sort((a, b) => {
    const aShown = isShown(a) ? 1 : 0;
    const bShown = isShown(b) ? 1 : 0;
    if (aShown !== bShown) return aShown - bShown;
    if (aShown) {
      if (allowShownRepeat) {
        const aCoolingDown = isCooldownEligible(a) ? 0 : 1;
        const bCoolingDown = isCooldownEligible(b) ? 0 : 1;
        if (aCoolingDown !== bCoolingDown) return aCoolingDown - bCoolingDown;
      }
      const shownDelta = shownAt(a) - shownAt(b);
      if (shownDelta !== 0) return shownDelta;
      if (allowShownRepeat) return rotationKey(a).localeCompare(rotationKey(b));
    }
    return compareSentimentHotPriority(a, b);
  });
  const seenKeys = new Set<string>();
  for (const candidate of sorted) {
    const keys = getSentimentHotCandidateHistoryKeys(candidate);
    if (keys.some((key) => seenKeys.has(key))) continue;
    keys.forEach((key) => seenKeys.add(key));
    unique.push(candidate);
  }
  return unique;
}

function collectSentimentHotSupplementCandidates(args: {
  ordered: SentimentHotCandidate[];
  archiveId: string;
  selectedKeys: Set<string>;
  limit: number;
  strictFreshOnly: boolean;
  freshnessDays?: number;
  keywords?: string[];
}): SentimentHotCandidate[] {
  const out: SentimentHotCandidate[] = [];
  const seenKeys = new Set<string>();
  const shownHistoryKeys = getSentimentHotShownHistoryKeys(args.archiveId);
  const shownAtMap = getSentimentHotShownHistoryAtMap(args.archiveId);
  const add = (candidate: SentimentHotCandidate, requireCooldown: boolean) => {
    if (out.length >= args.limit) return;
    const content = cleanSentimentCandidateContent(candidate.content || "");
    if (isGarbageOrUselessSentimentContent(content)) return;
    if (isCompletelyUnrelatedSentimentContent(candidate, args.keywords || [], "strict")) return;
    if (
      args.strictFreshOnly
      && isHistoricalSupplementCandidate(candidate)
      && !candidateMatchesOperationalFreshness(candidate, args.freshnessDays)
    ) return;
    if (args.strictFreshOnly && requireCooldown && !isSentimentHotCandidateRepeatEligibleWithState(candidate, shownHistoryKeys, shownAtMap)) return;
    const historyKeys = getSentimentHotCandidateHistoryKeys(candidate);
    if (historyKeys.some((key) => args.selectedKeys.has(key) || seenKeys.has(key))) return;
    historyKeys.forEach((key) => seenKeys.add(key));
    out.push(candidate);
  };
  // Strict fresh requests keep the cooldown hard. Unselected rows remain in
  // the pool and can return later, but not in an immediately repeated fetch.
  for (const candidate of args.ordered) add(candidate, true);
  if (!args.strictFreshOnly && out.length < args.limit) {
    for (const candidate of args.ordered) add(candidate, false);
  }
  return out;
}

function countMatchedNeedles(candidate: SentimentHotCandidate, needles: string[]): number {
  const haystack = [
    candidate.content,
    candidate.author,
  ].map(cleanText).join(" ").toLowerCase();
  return needles.filter((needle) => haystack.includes(needle.toLowerCase())).length;
}

function countMatchedNeedlesInContent(candidate: SentimentHotCandidate, needles: string[]): number {
  const haystack = cleanSentimentCandidateContent(candidate.content).toLowerCase();
  return needles.filter((needle) => haystack.includes(needle.toLowerCase())).length;
}

function candidateTouchesCurrentKeywords(candidate: SentimentHotCandidate, keywords: string[]): boolean {
  const needles = buildRelevanceNeedles(keywords);
  if (needles.length === 0) return false;
  return countMatchedNeedles(candidate, needles) > 0;
}

export function candidateMatchesCurrentKeywords(candidate: SentimentHotCandidate, keywords: string[], searchMode: SentimentHotSearchMode = "normal"): boolean {
  const source = sentimentCandidateSource(candidate);
  const rawSourceQuery = source === "threads-search-page" || source === "threads-account-search" || source === "threads-reader-search"
    ? cleanText((candidate.metrics as any)?.query)
    : "";
  const sourceQuery = sourceQueryBelongsToCurrentKeywordBatch(rawSourceQuery, keywords) ? rawSourceQuery : "";
  const relevanceKeywords = sourceQuery ? [sourceQuery, ...keywords] : keywords;
  const needles = buildRelevanceNeedlesForMode(relevanceKeywords, searchMode);
  if (needles.length === 0) return false;
  const strongNeedles = buildStrongRelevanceNeedlesForMode(relevanceKeywords, searchMode);
  // Relevance must come from the post body. Author names and the search query
  // field are not evidence that the article itself is on-topic.
  const matchedCount = countMatchedNeedlesInContent(candidate, needles);
  const matchedStrongCount = countMatchedNeedlesInContent(candidate, strongNeedles);
  const spiderSourceParts = source === "threads-reader-search"
    && (candidate.metrics as any)?.publicSearch === true
    && (candidate.metrics as any)?.crawler === "spider-http-hydration"
    && sourceQuery.length >= 4
    ? segmentPersonaWords(sourceQuery).filter((part) => (
        part.length >= 2
        && !isWeakRelevanceKeyword(part)
        && !isGenericSentimentKeyword(part)
      ))
    : [];
  const matchesSpiderSourcePart = spiderSourceParts.length > 0
    && countMatchedNeedlesInContent(candidate, spiderSourceParts) > 0;
  if (matchedCount <= 0 && !matchesSpiderSourcePart) return false;
  // Public Threads search can include recommendation cards unrelated to the
  // submitted term. Keep a card only when its visible author/content actually
  // contains the query or another current persona/platform tag.
  if (
    source === "threads-search-page"
    || source === "threads-reader-search"
    || (source === "threads-account-search" && (candidate.metrics as any)?.recentSearch === true)
  ) return true;
  if (searchMode === "normal") {
    // Authenticated cards were produced by this exact search query and the DOM
    // parser already proved that the visible card contains it. Preserve short
    // Chinese topics such as "地震" instead of requiring a second unrelated
    // persona term at the final gate.
    if (source === "threads-account-search" && sourceQuery.length === 2
      && isConcreteSearchKeyword(sourceQuery)
      && Array.isArray((candidate.metrics as any)?.matchedKeywords)
      && (candidate.metrics as any).matchedKeywords.some((item: unknown) => cleanText(item) === sourceQuery)
      && countMatchedNeedlesInContent(candidate, buildRelevanceNeedles([sourceQuery])) > 0) return true;
    const directNeedles = buildDirectRelevanceNeedles(relevanceKeywords);
    const directMatchedCount = countMatchedNeedlesInContent(candidate, directNeedles);
    const hasSpecificDirectMatch = directNeedles
      .filter((needle) => needle.length >= 3)
      .some((needle) => countMatchedNeedlesInContent(candidate, [needle]) > 0);
    return hasSpecificDirectMatch || directMatchedCount >= 2;
  }
  if (strongNeedles.length === 0) return matchedCount >= 2;
  return matchedStrongCount > 0 || matchedCount >= 2;
}

async function fetchThreadsSearchPageCandidates(args: {
  archiveId: string;
  keywords: string[];
  queryKeywords?: string[];
  queryRound?: number;
  limit: number;
  refresh?: boolean;
  freshnessDays?: number;
  allowCacheFallback?: boolean;
  /** Test-only: do not read shown-id/history state or write candidate cache. */
  ignoreHistory?: boolean;
  writeCache?: boolean;
  searchMode?: SentimentHotSearchMode;
  deadlineAt?: number;
  warnings?: string[];
  sourcePolicy?: "reader_first" | "reader_only" | "authenticated_only";
  deferRelevanceGate?: boolean;
}): Promise<SentimentHotCandidate[]> {
  const baseQueries = args.queryKeywords?.length
    ? buildModelOrderedThreadsSearchQueries(args.queryKeywords)
    : buildThreadsSearchQueries(args.keywords);
  const shownIds = args.ignoreHistory ? new Set<string>() : getSentimentHotShownIds(args.archiveId);
  const excluded = args.ignoreHistory ? new Set<string>() : getSentimentHotExcludedIds(args.archiveId);
  const excludedHistoryKeys = new Set<string>();
  const queryRound = Math.max(0, Math.floor(Number(args.queryRound) || 0));
  // Controller-issued keyword batches already rotate on the new host. Keep
  // their order stable here so the selected object-noun terms are actually queried
  // instead of rotating into derived variants based on display history.
  const baseSeed = args.queryKeywords?.length
    ? 0
    : shownIds.size + (args.refresh ? Math.floor(shownIds.size / Math.max(1, args.limit)) : 0);
  const roundSeed = baseSeed + queryRound * Math.max(1, Math.floor(baseQueries.length / 3));
  // queryKeywords is the authoritative batch supplied by the new-host model
  // controller. Do not expand it into local variants and silently turn two
  // Reader requests into a 20-request burst.
  const queries = args.queryKeywords?.length
    ? rotateSentimentQueries(baseQueries, roundSeed)
    : buildOrderedSentimentQueries(
        baseQueries,
        roundSeed,
        args.refresh === true || queryRound > 0,
      );
  if (queries.length === 0) return [];
  const publicSeedQueries = baseQueries.filter((query) => {
    const text = cleanText(query);
    if (!text || text.length > 6) return false;
    return !/(?:避坑|推荐|推薦|测评|測評|吐槽|真实|真實|故事|攻略|教程)/u.test(text);
  });
  // Public search has a tight interactive deadline. Search the platform/persona
  // tags first so the browser covers distinct user intent before derived
  // recommendation/tutorial variants of the first keyword consume the budget.
  const publicOriginalQueries = [...(args.queryKeywords || []), ...args.keywords]
    .map((query) => cleanText(query))
    .filter(Boolean);
  const publicBrowserQueries = [...new Set([
    ...queries,
    ...publicOriginalQueries,
    ...publicSeedQueries,
  ])].slice(0, THREADS_BROWSER_QUERY_LIMIT);

  const byId = new Map<string, SentimentHotCandidate>();
  const dedupeKeys = new Set<string>();
  const addAll = (candidates: SentimentHotCandidate[], freshnessDays = args.freshnessDays) => {
    for (const candidate of candidates) {
      if (freshnessDays && isHistoricalSupplementCandidate(candidate)) continue;
      if (!candidateMatchesOperationalFreshness(candidate, freshnessDays)) continue;
      const key = sentimentCandidateDedupeKey(candidate);
      if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
      if (byId.has(candidate.id) || dedupeKeys.has(key)) continue;
      byId.set(candidate.id, candidate);
      dedupeKeys.add(key);
      if (byId.size >= args.limit) break;
    }
  };

  const sourceLimit = args.limit;
  const sourceTimeoutMs = Math.min(
    SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS,
    remainingSentimentDeadlineMs(args.deadlineAt, SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS),
  );
  // The worker chooses the source boundary explicitly: interactive requests
  // use authenticated_only; scheduled candidate-pool refills use reader_only.
  const sourcePolicy = args.sourcePolicy || "reader_first";
  const allowReader = sourcePolicy !== "authenticated_only";
  const allowAuthenticated = sourcePolicy !== "reader_only";
  // A blocked Spider response can need a fresh proxy exit on the next request.
  // succeeds. Do not discard that successful response at the old 8s wrapper;
  // keep three seconds of the 30s source budget for normalization and return.
  const readerInitialTimeoutMs = Math.min(
    sourcePolicy === "reader_only" ? SENTIMENT_HOT_READER_ONLY_TOTAL_TIMEOUT_MS : 15_000,
    remainingSentimentDeadlineMs(args.deadlineAt, sourcePolicy === "reader_only" ? SENTIMENT_HOT_READER_ONLY_TOTAL_TIMEOUT_MS : 15_000),
  );
  const readerCandidates = allowReader ? await withSentimentTimeout(fetchThreadsReaderSearchCandidates({
      archiveId: args.archiveId,
      keywords: args.keywords,
      queries: queries.slice(0, THREADS_READER_QUERY_BATCH_SIZE),
      limit: sourceLimit,
      refresh: args.refresh,
      excludeIds: excluded,
      freshnessDays: args.freshnessDays,
      searchMode: args.searchMode,
      deadlineAt: args.deadlineAt,
      deferRelevanceGate: args.deferRelevanceGate,
  }).catch(() => []), readerInitialTimeoutMs, []) : [];
  addAll(readerCandidates);

  const authenticatedCookies = allowAuthenticated && byId.size < args.limit
    ? readSentimentBrowserAuthCookies("threads")
    : [];
  const hasAuthenticatedSession = hasValidThreadsSessionCookie(authenticatedCookies);
  const authenticatedBrowserTimeoutMs = Math.min(29_000, sourceTimeoutMs);
  const authenticatedBrowserDeadlineAt = args.deadlineAt
    ? Math.min(args.deadlineAt, Date.now() + authenticatedBrowserTimeoutMs)
    : Date.now() + authenticatedBrowserTimeoutMs;
  const authenticatedTimeoutFallback: SentimentHotCandidate[] = [];
  const authenticatedCandidates = hasAuthenticatedSession
    ? await withSentimentTimeout(fetchThreadsBrowserSearchCandidates({
      archiveId: args.archiveId,
      keywords: args.keywords,
      queries: publicBrowserQueries,
      limit: sourceLimit,
      excludeIds: excluded,
      freshnessDays: args.freshnessDays,
      ignoreHistory: args.ignoreHistory,
      searchMode: args.searchMode,
      // Threads sorts this authenticated search by recent posts; the strict
      // local publishedAt gate below enforces the exact requested day window.
      recentSearch: Number(args.freshnessDays || 0) > 0,
      deadlineAt: authenticatedBrowserDeadlineAt,
      warnings: args.warnings,
      allowUnauthenticated: false,
      publicOnly: false,
    }).catch(() => []), authenticatedBrowserTimeoutMs, authenticatedTimeoutFallback)
    : [];
  if (hasAuthenticatedSession && authenticatedCandidates === authenticatedTimeoutFallback) {
    args.warnings?.push("Threads \u6388\u6743\u8d26\u53f7\u72b6\u6001\u5f02\u5e38\uff08proxy_timeout\uff09\uff0c\u5c06\u5207\u6362\u8d26\u53f7\u4ee3\u7406\u51fa\u53e3\u3002");
  }
  addAll(authenticatedCandidates);
  if (allowAuthenticated && !hasAuthenticatedSession && byId.size < args.limit) {
    args.warnings?.push(
      allowReader
        ? "当前轮换账号缺少有效 Threads 登录态，已使用公开 Spider 受控补充；请检查该账号 Cookie。"
        : "当前轮换账号缺少有效 Threads 登录态；前台抓取不会改用公开 Spider，请检查该账号 Cookie。",
    );
  } else if (hasAuthenticatedSession) {
    args.warnings?.push("本轮已使用账号池 Threads 登录态抓取。");
    if (authenticatedCandidates.length === 0 && readerCandidates.length > 0) {
      args.warnings?.push("当前轮换账号未返回合格结果，已使用公开 Spider 受控补充。");
    }
  } else if (readerCandidates.length > 0) {
    args.warnings?.push("公开 Spider 已满足本轮候选需求，未占用账号池登录态。");
  }

  // Keep the freshness/heat/relevance hard gates unchanged, but do not rely only
  // on Threads' `filter=recent` ordering. The recent page often surfaces low-heat
  // posts first; the default search can expose higher-heat posts, and the same
  // freshnessDays filter below still rejects anything outside the allowed window.
  if (allowReader) {
    const remainingQueries = queries.slice(THREADS_READER_QUERY_BATCH_SIZE);
    for (let offset = 0; offset < remainingQueries.length; offset += THREADS_READER_QUERY_BATCH_SIZE) {
      if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
      const extraTimeoutMs = Math.min(6_000, remainingSentimentDeadlineMs(args.deadlineAt, 6_000));
      const extraCandidates = await withSentimentTimeout(fetchThreadsReaderSearchCandidates({
        archiveId: args.archiveId,
        keywords: args.keywords,
        queries: remainingQueries.slice(offset, offset + THREADS_READER_QUERY_BATCH_SIZE),
        limit: sourceLimit - byId.size,
        refresh: args.refresh,
        excludeIds: excluded,
        freshnessDays: args.freshnessDays,
        searchMode: args.searchMode,
        deadlineAt: args.deadlineAt,
        deferRelevanceGate: args.deferRelevanceGate,
      }).catch(() => []), extraTimeoutMs, []);
      addAll(extraCandidates);
    }
  }

  if (args.allowCacheFallback !== false && byId.size < args.limit) {
    addAll(readThreadsSearchCandidateCache(
      args.archiveId,
      args.keywords,
      args.limit - byId.size,
      true,
      args.searchMode,
    ));
  }

  const sorted = args.deferRelevanceGate
    ? sortUsefulHotCandidates([...byId.values()], args.limit)
    : sortSentimentHotCandidatePool([...byId.values()], args.keywords, args.limit, args.searchMode);
  if (sorted.length > 0 && args.writeCache !== false) writeThreadsSearchCandidateCache(args.archiveId, args.keywords, sorted, args.searchMode);
  return sorted;
}

type ThreadsSearchGraphqlTemplate = {
  endpoint: string;
  method: string;
  params: Record<string, string>;
  variables: Record<string, any>;
  headers: Record<string, string>;
  sourceTerms?: string[];
};

// A second search round in the same workflow should not depend on Threads
// emitting a fresh bootstrap request while it is rate-limiting the browser.
// Keep the captured template only for the lifetime of a short-lived process;
// cookies and request variables are still replaced for every query.
const THREADS_BROWSER_TEMPLATE_CACHE_TTL_MS = 5 * 60_000;
let recentThreadsSearchTemplate: { template: ThreadsSearchGraphqlTemplate; capturedAt: number } | null = null;

function readPersistedThreadsSearchTemplate(): { template: ThreadsSearchGraphqlTemplate; capturedAt: number } | null {
  try {
    if (!fs.existsSync(THREADS_SEARCH_GRAPHQL_TEMPLATE_CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(THREADS_SEARCH_GRAPHQL_TEMPLATE_CACHE_FILE, "utf8"));
    const capturedAt = Number(parsed?.capturedAt || 0);
    const template = parsed?.template as ThreadsSearchGraphqlTemplate | undefined;
    if (!capturedAt || Date.now() - capturedAt > THREADS_BROWSER_TEMPLATE_CACHE_TTL_MS) return null;
    if (!isUsableThreadsSearchGraphqlTemplate(template)) return null;
    return { template, capturedAt };
  } catch {
    return null;
  }
}

function persistThreadsSearchTemplate(value: { template: ThreadsSearchGraphqlTemplate; capturedAt: number }) {
  try {
    fs.mkdirSync(path.dirname(THREADS_SEARCH_GRAPHQL_TEMPLATE_CACHE_FILE), { recursive: true });
    const tempFile = `${THREADS_SEARCH_GRAPHQL_TEMPLATE_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, THREADS_SEARCH_GRAPHQL_TEMPLATE_CACHE_FILE);
  } catch {
    // A later browser request can capture the template again.
  }
}

function threadsSearchVariableQuery(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof child === "string"
      && cleanText(child)
      && /^(?:query|search_query|searchQuery|keyword|keywords|term|terms|text|searchText|search_text|searchTerm|search_term|searchKeyword|search_keyword)$/i.test(key)
    ) return cleanText(child);
    const nested = threadsSearchVariableQuery(child);
    if (nested) return nested;
  }
  return "";
}

function isKnownNonSearchThreadsGraphqlFriendlyName(value: unknown): boolean {
  const name = cleanText(value);
  return /(?:KeywordSearchGraphQLDataSource|CommunityEntityCards|EntityCards|Profile|User|Post|Story|Viewer|Notification|Direct|Activity|Insights|Mailbox|Presence|Settings|Follow)/i.test(name);
}

export function isUsableThreadsSearchGraphqlTemplate(value: unknown): boolean {
  const template = value as ThreadsSearchGraphqlTemplate | undefined;
  if (!template || typeof template !== "object") return false;
  if (!/^\/(?:graphql\/query|api\/graphql)(?:[/?]|$)/i.test(cleanText(template.endpoint))) return false;
  if (!template.variables || typeof template.variables !== "object") return false;
  const friendlyName = cleanText(template.params?.fb_api_req_friendly_name);
  if (isKnownNonSearchThreadsGraphqlFriendlyName(friendlyName)) return false;
  return Boolean(threadsSearchVariableQuery(template.variables))
    || (Array.isArray(template.sourceTerms) && template.sourceTerms.some((term) => cleanText(term)));
}

function threadsSearchTemplateMatchesQueries(template: ThreadsSearchGraphqlTemplate | null | undefined, queries: string[]): boolean {
  if (!template) return false;
  const templateTerms = Array.isArray(template.sourceTerms)
    ? template.sourceTerms.map(cleanText).filter(Boolean)
    : [];
  if (templateTerms.length === 0) return true;
  const currentTerms = queries.map(cleanText).filter(Boolean);
  if (currentTerms.length === 0) return true;
  return templateTerms.some((templateTerm) => currentTerms.some((term) => (
    templateTerm === term || templateTerm.includes(term) || term.includes(templateTerm)
  )));
}

function valueContainsAnyThreadsSearchTerm(value: unknown, terms: string[]): boolean {
  if (!value || terms.length === 0) return false;
  if (typeof value === "string") {
    const text = cleanText(value);
    return terms.some((term) => text === term || text.includes(term));
  }
  if (Array.isArray(value)) return value.some((item) => valueContainsAnyThreadsSearchTerm(item, terms));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => valueContainsAnyThreadsSearchTerm(item, terms));
  return false;
}

export function replaceThreadsSearchVariables(value: unknown, query: string, after?: string | null, recent?: boolean, pageSize?: number, sourceTerms: string[] = []): any {
  const normalizedSourceTerms = sourceTerms.map(cleanText).filter(Boolean);
  if (typeof value === "string" && normalizedSourceTerms.some((term) => cleanText(value) === term)) return query;
  if (Array.isArray(value)) return value.map((item) => replaceThreadsSearchVariables(item, query, after, recent, pageSize, normalizedSourceTerms));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^(?:query|search_query|searchQuery|keyword|keywords|term|terms|text|searchText|search_text|searchTerm|search_term|searchKeyword|search_keyword)$/i.test(key)
      && typeof child === "string"
    ) next[key] = query;
    else if (/^(?:after|cursor)$/i.test(key) && (child === null || typeof child === "string")) next[key] = after || null;
    else if (/^recent$/i.test(key) && recent !== undefined && (typeof child === "number" || typeof child === "boolean")) next[key] = recent ? 1 : 0;
    else if (/^first$/i.test(key) && typeof child === "number" && pageSize) next[key] = Math.max(child, pageSize);
    else next[key] = replaceThreadsSearchVariables(child, query, after, recent, pageSize, normalizedSourceTerms);
  }
  return next;
}

function extractThreadsGraphqlPostMedia(post: any): SentimentHotMedia[] {
  const media: SentimentHotMedia[] = [];
  const bestVersionUrl = (list: any): string => {
    if (!Array.isArray(list) || !list.length) return "";
    const ranked = [...list].sort((left, right) => Number(right?.width || 0) - Number(left?.width || 0));
    return cleanText(ranked[0]?.url);
  };
  const add = (urlValue: unknown, type: SentimentHotMedia["type"] = "image", thumbnailUrl = "") => {
    const url = cleanText(urlValue);
    if (!/^https?:\/\//i.test(url) || isNonPostThreadsMediaUrl(url)) return;
    const thumb = cleanText(thumbnailUrl);
    const existingIndex = media.findIndex((item) => (
      isSameMediaAsset(item.url, url)
      || (thumb && isSameMediaAsset(item.url, thumb))
      || (item.thumbnailUrl && (isSameMediaAsset(item.thumbnailUrl, url) || (thumb && isSameMediaAsset(item.thumbnailUrl, thumb))))
    ));
    if (existingIndex >= 0) {
      const current = media[existingIndex];
      const nextType = type === "video" || current.type === "video" ? "video" : type;
      const nextUrl = nextType === "video"
        ? (type === "video" ? url : current.url)
        : (mediaAssetQuality(url) > mediaAssetQuality(current.url) ? url : current.url);
      const nextThumb = nextType === "video"
        ? (type === "video" ? (thumb || current.thumbnailUrl || (current.type === "image" ? current.url : "")) : (thumb || url || current.thumbnailUrl))
        : (current.thumbnailUrl || thumb);
      media[existingIndex] = {
        type: nextType,
        url: nextUrl,
        ...(nextThumb && nextThumb !== nextUrl ? { thumbnailUrl: nextThumb } : {}),
      };
      return;
    }
    media.push({
      type,
      url,
      ...(thumb && thumb !== url ? { thumbnailUrl: thumb } : {}),
    });
  };
  const addItem = (item: any) => {
    const imageUrl = bestVersionUrl(item?.image_versions2?.candidates)
      || cleanText(item?.display_url || item?.image_url || item?.thumbnail_url || item?.display_uri);
    const videoUrl = bestVersionUrl(item?.video_versions) || cleanText(item?.video_url);
    if (videoUrl) add(videoUrl, "video", imageUrl);
    else if (imageUrl) add(imageUrl, "image");
    const nested = item?.text_post_app_info?.linked_inline_media || item?.linked_inline_media;
    if (nested && nested !== item) addItem(nested);
  };
  addItem(post);
  for (const item of Array.isArray(post?.carousel_media) ? post.carousel_media : []) addItem(item);
  return media.slice(0, 12);
}

export function parseThreadsGraphqlSearchPayload(args: {
  payload: any;
  query: string;
  keywords?: string[];
}): SentimentHotCandidate[] {
  const out: SentimentHotCandidate[] = [];
  const byId = new Set<string>();
  const stack: any[] = [args.payload];
  const visited = new Set<any>();
  const needles = buildRelevanceNeedles([args.query, ...(args.keywords || [])]);
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value)) {
      const username = cleanText(value?.user?.username || value?.owner?.username).replace(/^@+/, "");
      const code = cleanText(value?.code || value?.shortcode);
      const content = cleanSentimentCandidateContent(value?.caption?.text || value?.text_post_app_info?.text || value?.text || "");
      if (username && code && content) {
        const likeCount = Math.max(0, Number(value?.like_count) || 0);
        const commentCount = Math.max(0, Number(value?.text_post_app_info?.direct_reply_count) || 0);
        const repostCount = Math.max(0, Number(value?.text_post_app_info?.repost_count) || 0);
        const reshareCount = Math.max(0, Number(value?.text_post_app_info?.reshare_count) || 0);
        const rawViewCount = [
          value?.text_post_app_info?.view_count,
          value?.text_post_app_info?.viewCount,
          value?.view_count,
          value?.viewCount,
          value?.play_count,
          value?.playCount,
        ].find((item) => item !== null && item !== undefined && item !== "");
        const viewCount = rawViewCount === undefined
          ? undefined
          : Math.max(0, Number(rawViewCount) || 0);
        const sourceUrl = `https://www.threads.com/@${encodeURIComponent(username)}/post/${encodeURIComponent(code)}`;
        const id = buildSentimentCandidateId({ platform: "threads", sourceUrl, content });
        if (!byId.has(id)) {
          byId.add(id);
          const haystack = [content, username].join(" ").toLowerCase();
          const matchedKeywords = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
          const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {
            likeCount,
            commentCount,
            shareCount: reshareCount,
            rawSignals: [likeCount, commentCount, repostCount, reshareCount],
          };
          if (typeof viewCount === "number") engagement.viewCount = viewCount;
          const hotScore = realSentimentHotScore(engagement);
          // A current search position is not a publication timestamp. Only use
          // the timestamp present in the public post payload for freshness.
          const publishedAt = normalizeThreadsTimestamp(
            value?.taken_at ?? value?.taken_at_timestamp ?? value?.created_at ?? value?.caption?.created_at,
          );
          out.push({
            id,
            platform: "threads",
            sourceUrl,
            author: username,
            content,
            media: extractThreadsGraphqlPostMedia(value),
            hotScore,
            metrics: {
              source: "threads-account-search",
              query: args.query,
              matchedKeywords,
              like_count: likeCount,
              comment_count: commentCount,
              repost_count: repostCount,
              reshare_count: reshareCount,
              share_count: reshareCount,
              ...(typeof viewCount === "number" ? { view_count: viewCount } : {}),
              realEngagementTotal: hotScore,
            },
            engagement,
            ...(publishedAt ? { publishedAt } : {}),
            capturedAt: new Date().toISOString(),
            warnings: [],
          });
        }
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return out;
}

export function parseThreadsSearchHydrationPayloads(args: {
  scripts: string[];
  query: string;
  keywords?: string[];
}): SentimentHotCandidate[] {
  const byId = new Map<string, SentimentHotCandidate>();
  for (const raw of args.scripts || []) {
    if (!raw || (!raw.includes("text_post_app_info") && !raw.includes("\"like_count\""))) continue;
    const payload = safeJson(raw);
    if (!payload) continue;
    for (const candidate of parseThreadsGraphqlSearchPayload({ ...args, payload })) {
      if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()];
}

export function parseThreadsGraphqlSearchPageInfo(payload: any): { endCursor: string; hasNextPage: boolean } | null {
  const stack: any[] = [payload];
  const visited = new Set<any>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    const pageInfo = value.page_info || value.pageInfo;
    const endCursor = cleanText(pageInfo?.end_cursor || pageInfo?.endCursor);
    const hasNextPage = Boolean(pageInfo?.has_next_page ?? pageInfo?.hasNextPage);
    if (endCursor) return { endCursor, hasNextPage };
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return null;
}

async function requestThreadsGraphqlSearchPayload(args: {
  page: any;
  template: ThreadsSearchGraphqlTemplate;
  query: string;
  after?: string | null;
  recent?: boolean;
  deadlineAt?: number;
}): Promise<any | null> {
  const params = new URLSearchParams(args.template.params);
  params.set("variables", JSON.stringify(replaceThreadsSearchVariables(args.template.variables, args.query, args.after, args.recent, 25, args.template.sourceTerms || [])));
  const method = args.template.method === "GET" ? "GET" : "POST";
  const endpoint = method === "GET"
    ? `${args.template.endpoint.split("?")[0]}?${params.toString()}`
    : args.template.endpoint;
  const timeoutMs = Math.min(THREADS_BROWSER_REQUEST_TIMEOUT_MS, remainingSentimentDeadlineMs(args.deadlineAt, THREADS_BROWSER_REQUEST_TIMEOUT_MS));
  if (timeoutMs < 1_000) return null;
  try {
    const response = await threadsGraphqlRateLimiter.run(
      THREADS_GRAPHQL_UPSTREAM_KEY,
      async ({ signal }) => {
        if (signal.aborted) throw signal.reason;
        const result = await args.page.evaluate(async ({ endpoint, method, body, headers, timeoutMs }: any) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(endpoint || "/graphql/query", {
              method,
              credentials: "include",
              headers,
              body: method === "GET" ? undefined : body,
              signal: controller.signal,
            });
            return {
              ok: response.ok,
              status: response.status,
              retryAfter: response.headers.get("retry-after") || "",
              text: response.ok ? await response.text() : "",
            };
          } catch {
            return { ok: false, status: 0, retryAfter: "", text: "" };
          } finally {
            clearTimeout(timeoutId);
          }
        }, { endpoint, method, body: params.toString(), headers: args.template.headers, timeoutMs });
        return {
          ...result,
          headers: { "retry-after": result.retryAfter },
        };
      },
      { timeoutMs },
    );
    if (!response.ok) {
      console.warn(`[sentiment_hot_graphql_request] status=${response.status} retryAfter=${JSON.stringify(response.headers["retry-after"] || "")} query=${JSON.stringify(args.query)}`);
      return null;
    }
    return safeJson(response.text);
  } catch {
    return null;
  }
}

async function fetchThreadsBrowserSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  excludeIds?: Set<string>;
  deadlineAt?: number;
  freshnessDays?: number;
  ignoreHistory?: boolean;
  searchMode?: SentimentHotSearchMode;
  warnings?: string[];
  recentSearch?: boolean;
  /** Public Threads search must work without any account session. */
  allowUnauthenticated?: boolean;
  /** Do not attach a stored session to a public-hot-search request. */
  publicOnly?: boolean;
}): Promise<SentimentHotCandidate[]> {
  const cookies = readSentimentBrowserAuthCookies("threads");
  const sessionCookieCount = cookies.filter((cookie: any) => String(cookie?.name || "").toLowerCase() === "sessionid" && String(cookie?.value || "").trim()).length;
  const hasSession = hasValidThreadsSessionCookie(cookies);
  const useSession = hasSession && !args.publicOnly;
  if (!useSession && !args.allowUnauthenticated) {
    console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} sessionid=0 cookies=${cookies.length} status=skip_no_session`);
    return [];
  }
  const slotTimeoutMs = Math.min(
    args.publicOnly ? THREADS_PUBLIC_BROWSER_TIMEOUT_MS : SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS,
    remainingSentimentDeadlineMs(args.deadlineAt, args.publicOnly ? THREADS_PUBLIC_BROWSER_TIMEOUT_MS : SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS),
  );
  if (args.deadlineAt && slotTimeoutMs <= 0) return [];
  let releaseBrowserSlot: () => void;
  try {
    releaseBrowserSlot = await acquireSentimentBrowserWorkSlot({ timeoutMs: slotTimeoutMs });
  } catch (error) {
    if (String(error).includes("sentiment_browser_slot_timeout")) {
      console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=skip_slot_timeout`);
      return [];
    }
    throw error;
  }
  console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} sessionid=${sessionCookieCount} cookies=${cookies.length} mode=${useSession ? "authenticated" : "public"} queries=${args.queries.length} leading=${JSON.stringify(args.queries.slice(0, 6))} status=start`);
  const excluded = args.excludeIds || getSentimentHotRefreshExcludedIds(args.archiveId);
  const excludedHistoryKeys = new Set<string>();
  const results: SentimentHotCandidate[] = [];
  const resultKeys = new Set<string>();
  const globalPoolCandidates = new Map<string, SentimentHotCandidate>();
  const collectGlobalPoolCandidates = (items: SentimentHotCandidate[]) => {
    for (const item of items) {
      if (item?.id) globalPoolCandidates.set(item.id, item);
    }
  };
  const detailRescueCandidates = new Map<string, SentimentHotCandidate>();
  const attemptedDetailRescueKeys = new Set<string>();
  const stats = {
    pages: 1,
    queries: 0,
    graphql: 0,
    hydration: 0,
    accepted: 0,
    detailQueued: 0,
    detailAttempted: 0,
    detailPromoted: 0,
    detailSkippedBudget: 0,
    rejected: {} as Record<string, number>,
  };
  const templateStats = { seen: 0, noVariables: 0, apiNonSearch: 0, noSearchMarker: 0, captured: 0 };
  const capturedGraphqlPayloadKeys = new Set<string>();
  let threadsAuthBlocked = false;
  let browser: any = null;
  let browserDeadlineTimer: NodeJS.Timeout | undefined;
  if (args.deadlineAt) {
    browserDeadlineTimer = setTimeout(() => {
      console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=deadline_reached`);
      void browser?.close().catch(() => undefined);
    }, Math.max(1, args.deadlineAt - Date.now()));
  }
  const markThreadsAuthBlocked = (reason: string) => {
    threadsAuthBlocked = true;
    if (useSession) {
      pushSentimentHotWarning(args.warnings || [], `Threads 授权账号状态异常（${reason}），请在后台重新授权或更换可用 Threads 账号。`);
    } else {
      pushSentimentHotWarning(args.warnings || [], `Threads 公开搜索暂时要求验证（${reason}），本轮未使用登录态，也未放宽热点筛选条件。`);
    }
  };
  const considerCandidate = (candidate: SentimentHotCandidate, countRejection = true) => {
    collectGlobalPoolCandidates([candidate]);
    const relevanceKeywords = args.publicOnly ? [cleanText((candidate.metrics as any)?.query), ...args.keywords].filter(Boolean) : args.keywords;
    const normalized = candidateMeetsDisplayQuality(
      candidate,
      relevanceKeywords,
      args.searchMode,
      args.freshnessDays,
      countRejection ? stats.rejected : undefined,
    );
    if (!normalized) {
      if (
        !isUsefulHotCandidate(candidate)
        && detailRescueCandidates.size < THREADS_BROWSER_DETAIL_RESCUE_POOL_LIMIT
        && candidateMeetsDisplayQuality(candidate, relevanceKeywords, args.searchMode, args.freshnessDays, undefined, true)
      ) {
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (!detailRescueCandidates.has(dedupeKey)) {
          detailRescueCandidates.set(dedupeKey, candidate);
          stats.detailQueued += 1;
        }
      }
      return false;
    }
    const dedupeKey = sentimentCandidateDedupeKey(normalized);
    if (resultKeys.has(dedupeKey) || results.some((entry) => entry.id === normalized.id)) return false;
    results.push(normalized);
    resultKeys.add(dedupeKey);
    stats.accepted += 1;
    return true;
  };
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch(buildLocalChromiumLaunchOptions());
    try {
      const context = await browser.newContext({
        locale: "zh-TW",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      });
      if (useSession) await addCookiesBestEffort(context, cookies as any[]);
      const page = await context.newPage();
      let detailRescueRunning: Promise<void> | null = null;
      const rescueDetailCandidates = async () => {
        const relevanceNeedles = buildRelevanceNeedlesForMode(args.keywords, normalizeSentimentHotSearchMode(args.searchMode));
        while (attemptedDetailRescueKeys.size < THREADS_BROWSER_DETAIL_RESCUE_LIMIT && results.length < args.limit) {
          const remainingMs = remainingSentimentDeadlineMs(args.deadlineAt, 15_000);
          if (remainingMs < THREADS_BROWSER_DETAIL_RESCUE_MIN_REMAINING_MS) break;
          const batch = [...detailRescueCandidates.entries()]
            .filter(([key]) => !attemptedDetailRescueKeys.has(key))
            .sort(([, a], [, b]) => {
              const relevanceDelta = countMatchedNeedles(b, relevanceNeedles) - countMatchedNeedles(a, relevanceNeedles);
              if (relevanceDelta !== 0) return relevanceDelta;
              return compareSentimentHotFreshness(a, b) || Number(b.hotScore || 0) - Number(a.hotScore || 0);
            })
            .slice(0, Math.min(
              THREADS_BROWSER_DETAIL_RESCUE_BATCH_SIZE,
              THREADS_BROWSER_DETAIL_RESCUE_LIMIT - attemptedDetailRescueKeys.size,
            ));
          if (batch.length === 0) break;
          batch.forEach(([key]) => attemptedDetailRescueKeys.add(key));
          stats.detailAttempted += batch.length;
          const enriched = await withSentimentTimeout(
            enrichThreadsCandidateDetails(batch.map(([, candidate]) => candidate), {
              force: true,
              browserContext: context,
              browserConcurrency: boundedBrowserPageConcurrency(batch.length),
              includeReader: false,
            }),
            Math.max(THREADS_BROWSER_DETAIL_RESCUE_MIN_REMAINING_MS, Math.min(15_000, remainingMs - 500)),
            batch.map(([, candidate]) => candidate),
          );
          for (const candidate of enriched) {
            if (considerCandidate(candidate, false)) stats.detailPromoted += 1;
          }
        }
      };
      const rescueDetailCandidatesIfUseful = async (minimumRemainingMs = THREADS_BROWSER_DETAIL_RESCUE_MIN_REMAINING_MS) => {
        if (results.length >= args.limit) return;
        if (detailRescueCandidates.size <= attemptedDetailRescueKeys.size) return;
        if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < minimumRemainingMs) {
          stats.detailSkippedBudget += Math.max(0, detailRescueCandidates.size - attemptedDetailRescueKeys.size);
          return;
        }
        if (!detailRescueRunning) {
          detailRescueRunning = rescueDetailCandidates().finally(() => {
            detailRescueRunning = null;
          });
        }
        await detailRescueRunning;
      };
      const useGraphqlTemplate = shouldUseThreadsSearchGraphqlTemplate({
        publicOnly: args.publicOnly === true,
        authenticated: useSession,
        collectorProfileRequired: /^(?:1|true|yes|on)$/i.test(cleanText(process.env.TG_COLLECTOR_PROFILE_REQUIRED)),
      });
      const persistedTemplate = useGraphqlTemplate ? readPersistedThreadsSearchTemplate() : null;
      if (useGraphqlTemplate && !recentThreadsSearchTemplate && persistedTemplate && threadsSearchTemplateMatchesQueries(persistedTemplate.template, args.queries)) recentThreadsSearchTemplate = persistedTemplate;
      const cachedTemplate = useGraphqlTemplate && recentThreadsSearchTemplate
        && Date.now() - recentThreadsSearchTemplate.capturedAt <= THREADS_BROWSER_TEMPLATE_CACHE_TTL_MS
        && threadsSearchTemplateMatchesQueries(recentThreadsSearchTemplate.template, args.queries)
        ? recentThreadsSearchTemplate.template
        : null;
      let template: ThreadsSearchGraphqlTemplate | null = cachedTemplate;
      const captureTemplate = async (request: any) => {
        try {
          if (!useGraphqlTemplate) return;
          const requestUrlText = String(request.url?.() || "");
          if (template || !/(?:\/graphql\/query|\/api\/graphql)(?:[/?]|$)/i.test(requestUrlText)) return;
          templateStats.seen += 1;
          const requestUrl = new URL(requestUrlText);
          const params = new URLSearchParams(String(request.postData?.() || "") || requestUrl.search);
          const friendlyName = cleanText(params.get("fb_api_req_friendly_name"));
          const variables = safeJson(params.get("variables") || "");
          if (!variables || typeof variables !== "object") {
            templateStats.noVariables += 1;
            return;
          }
          const sourceTerms = args.queries.map(cleanText).filter((term) => term && valueContainsAnyThreadsSearchTerm(variables, [term]));
          const isApiGraphql = /\/api\/graphql(?:[/?]|$)/i.test(requestUrl.pathname);
          if (isApiGraphql && !/search/i.test(friendlyName)) {
            templateStats.apiNonSearch += 1;
            return;
          }
          if (!isUsableThreadsSearchGraphqlTemplate({
            endpoint: requestUrl.pathname || "/graphql/query",
            method: String(request.method?.() || "POST").toUpperCase(),
            params: { fb_api_req_friendly_name: friendlyName },
            variables,
            headers: {},
            sourceTerms,
          })) {
            templateStats.noSearchMarker += 1;
            return;
          }
          const requestParams: Record<string, string> = {};
          for (const [key, value] of params.entries()) {
            if (key !== "variables") requestParams[key] = value;
          }
          const allHeaders = await request.allHeaders?.();
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(allHeaders || {})) {
            if (key === "content-type" || key.startsWith("x-")) headers[key] = String(value);
          }
          template = {
            endpoint: requestUrl.pathname || "/graphql/query",
            method: String(request.method?.() || "POST").toUpperCase(),
            params: requestParams,
            variables,
            headers,
            sourceTerms,
          };
          recentThreadsSearchTemplate = { template, capturedAt: Date.now() };
          persistThreadsSearchTemplate(recentThreadsSearchTemplate);
          templateStats.captured += 1;
        } catch {
          // Continue waiting for the next search request.
        }
      };
      if (!template && !args.publicOnly) page.on("request", captureTemplate);
      const bootstrapQueryLimit = args.publicOnly
        ? 1
        : (useGraphqlTemplate ? THREADS_BROWSER_BOOTSTRAP_QUERY_LIMIT : 0);
      const bootstrapQueries = [...new Set(args.queries.slice(0, bootstrapQueryLimit).filter(Boolean))];
      const recentSearch = typeof args.recentSearch === "boolean" ? args.recentSearch : Number(args.freshnessDays || 0) > 0;
      const triggerThreadsManualSearch = async (searchPage: any, query: string) => {
        if (!query || results.length >= args.limit) return false;
        if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 3_000) return false;
        try {
          if (!/threads\.com\/search(?:[/?#]|$)/i.test(String(searchPage.url?.() || ""))) {
            await searchPage.goto("https://www.threads.com/search", {
              waitUntil: "domcontentloaded",
              timeout: Math.min(10_000, remainingSentimentDeadlineMs(args.deadlineAt, 10_000)),
            }).catch(() => undefined);
          }
          await searchPage.waitForTimeout(Math.min(300, remainingSentimentDeadlineMs(args.deadlineAt, 300))).catch(() => undefined);
          const selectors = [
            'input[type="search"]',
            'input[placeholder*="Search"]',
            'input[placeholder*="搜尋"]',
            'input[placeholder*="搜索"]',
            'input[aria-label*="Search"]',
            'input[aria-label*="搜尋"]',
            'input[aria-label*="搜索"]',
            'input[type="text"]',
          ];
          for (const selector of selectors) {
            const input = searchPage.locator(selector).first();
            const visible = await input.isVisible({ timeout: 600 }).catch(() => false);
            if (!visible) continue;
            await input.click({ timeout: 800 }).catch(() => undefined);
            await input.fill(query, { timeout: 1_000 }).catch(async () => {
              await searchPage.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
              await searchPage.keyboard.type(query, { delay: 8 }).catch(() => undefined);
            });
            await input.press("Enter", { timeout: 1_000 }).catch(() => searchPage.keyboard.press("Enter").catch(() => undefined));
            await searchPage.waitForTimeout(Math.min(THREADS_MANUAL_SEARCH_TRIGGER_WAIT_MS, remainingSentimentDeadlineMs(args.deadlineAt, THREADS_MANUAL_SEARCH_TRIGGER_WAIT_MS))).catch(() => undefined);
            console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} source=threads_manual_search query=${JSON.stringify(query)} url=${JSON.stringify(String(searchPage.url?.() || ""))}`);
            return true;
          }
        } catch {
          // Manual search is only a capture aid; direct URL and DOM parsing remain available.
        }
        return false;
      };
      const collectDomCandidates = async (searchPage: any, query: string, scrollAttempts = 3, useRecentSearch = recentSearch) => {
        if (results.length >= args.limit) return;
        const responsePayloads: Promise<any | null>[] = [];
        const captureGraphqlResponse = (response: any) => {
          try {
            const responseUrl = String(response.url?.() || "");
            if (!/(?:\/graphql\/query|\/api\/graphql)(?:[/?]|$)/i.test(responseUrl)) return;
            const responseStatus = typeof response.status === "function" ? Number(response.status()) : 0;
            if (responseStatus === 429) {
              markThreadsAuthBlocked("rate_limited");
              return;
            }
            if (responseStatus >= 400) return;
            if (responsePayloads.length >= 48) return;
            responsePayloads.push((async () => {
              try {
                const text = await response.text();
                if (!text) return null;
                if (/checkpoint_required|accounts\/suspended|account_suspended/i.test(text)) {
                  markThreadsAuthBlocked("checkpoint_required");
                  return null;
                }
                const key = crypto.createHash("sha1").update(text.slice(0, 32_768)).digest("hex");
                if (capturedGraphqlPayloadKeys.has(key)) return null;
                capturedGraphqlPayloadKeys.add(key);
                return safeJson(text);
              } catch {
                return null;
              }
            })());
          } catch {
            // Ignore non-standard Playwright response objects.
          }
        };
        const collectGraphqlResponseCandidates = async () => {
          if (responsePayloads.length === 0 || results.length >= args.limit) return 0;
          const payloads = await Promise.all(responsePayloads.splice(0, responsePayloads.length));
          let parsedTotal = 0;
          let acceptedTotal = 0;
          for (const payload of payloads) {
            if (!payload) continue;
          const parsed = parseThreadsGraphqlSearchPayload({
            payload,
            query,
            keywords: args.keywords,
          });
            collectGlobalPoolCandidates(parsed);
            parsedTotal += parsed.length;
            for (const candidate of parsed) {
              if (excluded.has(candidate.id)) continue;
              if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
              const searchCandidate = args.publicOnly ? {
                ...candidate,
                metrics: {
                  ...(candidate.metrics || {}),
                  source: "threads-search-page",
                  publicSearch: true,
                },
              } : candidate;
              if (considerCandidate(searchCandidate)) acceptedTotal += 1;
              if (results.length >= args.limit) break;
            }
            if (results.length >= args.limit) break;
          }
          stats.graphql += parsedTotal;
          if (parsedTotal > 0) {
            console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} source=threads_page_graphql query=${JSON.stringify(query)} graphql=${parsedTotal} accepted=${acceptedTotal} total=${results.length}`);
          }
          return parsedTotal;
        };
        const collectDomTextCandidates = async () => {
          const bodyText = await searchPage.locator("body").innerText({ timeout: args.publicOnly ? 500 : 2_000 }).catch(() => "");
          const postUrls = await searchPage.$$eval('a[href*="/post/"]', (anchors: any[]) => anchors
            .map((anchor) => String(anchor.href || anchor.getAttribute?.("href") || "").trim())
            .filter(Boolean)).catch(() => []);
          const parsedDomCandidates = parseThreadsSearchTextCandidates({
            text: bodyText,
            query,
            keywords: args.publicOnly ? [query, ...args.keywords] : args.keywords,
            limit: Math.max(0, args.limit - results.length),
            sourceUrl: String(searchPage.url?.() || buildThreadsSearchUrl(query, useRecentSearch)),
            sourceUrls: postUrls,
          });
          const domCandidates = args.publicOnly ? parsedDomCandidates : parsedDomCandidates.map((candidate) => ({
            ...candidate,
            metrics: {
              ...(candidate.metrics || {}),
              source: "threads-account-search",
              publicSearch: false,
              recentSearch: useRecentSearch,
            },
          }));
          const cardRows = await searchPage.$$eval('a[href*="/post/"]', (anchors: any[]) => {
            const seen = new Set<string>();
            const rows: Array<{ sourceUrl: string; text: string }> = [];
            for (const anchor of anchors) {
              const href = String(anchor.href || anchor.getAttribute?.("href") || "").trim();
              const match = href.match(/^(https?:\/\/[^/]+)?\/@([^/]+)\/post\/([^/?#]+)/i);
              if (!match) continue;
              const sourceUrl = `https://www.threads.com/@${match[2]}/post/${match[3]}`;
              if (seen.has(sourceUrl)) continue;
              let node: any = anchor;
              for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
                const text = String(node.innerText || "").trim();
                const postLinkCount = Number(node.querySelectorAll?.('a[href*="/post/"]')?.length || 0);
                if (text.length < 40 || postLinkCount > 2) continue;
                seen.add(sourceUrl);
                rows.push({ sourceUrl, text });
                break;
              }
            }
            return rows.slice(0, 40);
          }).catch(() => []);
          const cardCandidates = parseThreadsSearchCardCandidates({
            cards: cardRows,
            query,
            keywords: args.keywords,
          });
          collectGlobalPoolCandidates([...cardCandidates, ...domCandidates]);
          for (const candidate of [...cardCandidates, ...domCandidates]) {
            if (excluded.has(candidate.id)) continue;
            considerCandidate(candidate);
            if (results.length >= args.limit) break;
          }
          return cardCandidates.length + domCandidates.length;
        };
        searchPage.on("response", captureGraphqlResponse);
        const collectHydrationCandidates = async () => {
          const scripts = await searchPage.$$eval("script", (items: any[]) => items
            .map((item: any) => String(item.textContent || ""))
            .filter((text: string) => text.includes("text_post_app_info") || text.includes("\"like_count\"") || text.includes("searchResults")))
            .catch(() => []);
          const hydrated = parseThreadsSearchHydrationPayloads({
            scripts,
            query,
            keywords: args.keywords,
          });
          collectGlobalPoolCandidates(hydrated);
          stats.hydration += hydrated.length;
          for (const candidate of hydrated) {
            if (excluded.has(candidate.id)) continue;
            if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
            considerCandidate(args.publicOnly ? {
              ...candidate,
              metrics: {
                ...(candidate.metrics || {}),
                source: "threads-search-page",
                publicSearch: true,
              },
            } : candidate);
            if (results.length >= args.limit) break;
          }
          return hydrated.length;
        };
        try {
          const publicGotoTimeoutMs = args.publicOnly ? 10_000 : 16_000;
          let navigationFailed = false;
          const navigationResponse = await searchPage.goto(buildThreadsSearchUrl(query, useRecentSearch), {
            waitUntil: "domcontentloaded",
            timeout: Math.min(publicGotoTimeoutMs, remainingSentimentDeadlineMs(args.deadlineAt, publicGotoTimeoutMs)),
          }).catch(() => {
            navigationFailed = true;
            return undefined;
          });
          if (useSession && navigationFailed) {
            markThreadsAuthBlocked("navigation_timeout");
            console.info("[sentiment_hot_browser_search] archiveId=" + args.archiveId + " status=auth_blocked reason=navigation_timeout");
            throw new Error("threads_auth_navigation_timeout");
          }
          if (useSession && Number(navigationResponse?.status?.() || 0) === 429) {
            markThreadsAuthBlocked("rate_limited");
          }
          const currentUrl = String(searchPage.url?.() || "");
          if (/\/accounts\/suspended\/|checkpoint|login/i.test(currentUrl)) {
            markThreadsAuthBlocked(/suspended/i.test(currentUrl) ? "accounts_suspended" : "checkpoint_required");
            console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=auth_blocked url=${JSON.stringify(currentUrl)}`);
            return;
          }
          const cookieConsentButtons = searchPage.locator("button").filter({ hasText: /Cookie/i });
          if (await cookieConsentButtons.count().catch(() => 0)) await cookieConsentButtons.last().click().catch(() => undefined);
          if (args.publicOnly) {
            // `domcontentloaded` only exposes the search shell. Public Threads
            // cards arrive from `/ajax/bz` roughly 4-6 seconds later. Wait for a
            // real post card or an explicit terminal empty state instead of
            // parsing the still-empty shell after a fixed 150ms delay.
            const readyWaitMs = Math.min(
              THREADS_PUBLIC_RESULTS_WAIT_MS,
              remainingSentimentDeadlineMs(args.deadlineAt, THREADS_PUBLIC_RESULTS_WAIT_MS),
            );
            if (readyWaitMs > 0) {
              await searchPage.waitForFunction(() => {
                if (document.querySelector('a[href*="/post/"]')) return true;
                const text = String(document.body?.innerText || "");
                return /(?:查無結果|没有结果|沒有結果|No results|Log in to see)/i.test(text);
              }, undefined, { timeout: readyWaitMs, polling: 200 }).catch(() => undefined);
            }
          } else {
            const authenticatedReadyWaitMs = Math.min(
              2_000,
              remainingSentimentDeadlineMs(args.deadlineAt, 2_000),
            );
            if (authenticatedReadyWaitMs > 0) {
              await searchPage.waitForFunction(() => {
                if (document.querySelector('a[href*="/post/"]')) return true;
                const text = String(document.body?.innerText || "");
                return /(?:查無結果|没有结果|沒有結果|No results|Log in or sign up for Threads)/i.test(text);
              }, undefined, { timeout: authenticatedReadyWaitMs, polling: 200 }).catch(() => undefined);
            }
            const authenticatedPageState = await searchPage.evaluate(() => ({
              hasPostLink: Boolean(document.querySelector('a[href*="/post/"]')),
              bodyText: String(document.body?.innerText || ""),
            })).catch(() => ({ hasPostLink: false, bodyText: "" }));
            if (!authenticatedPageState.hasPostLink && readerBodyLooksLikeLoginWall(authenticatedPageState.bodyText)) {
              markThreadsAuthBlocked("login_wall");
              console.info("[sentiment_hot_browser_search] archiveId=" + args.archiveId + " status=auth_blocked reason=login_wall");
              throw new Error("threads_auth_login_wall");
            }
          }
          // The rendered cards are the fastest complete source on the current
          // authenticated search page. Parse them before walking large
          // hydration payloads; otherwise the source deadline can close the
          // browser with ten already-visible qualified posts still unread.
          const initialDomCount = await collectDomTextCandidates();
          // Search cards usually expose reactions but not view counts. Rescue
          // those candidates immediately while this authenticated context and
          // its time budget are still available; waiting until all bootstrap
          // queries finish leaves no time to verify whether they clear 500.
          if (!args.publicOnly && initialDomCount > 0 && results.length < args.limit) {
            await rescueDetailCandidatesIfUseful(THREADS_BROWSER_EARLY_DETAIL_RESCUE_MIN_REMAINING_MS);
          }
          if (results.length >= args.limit) return;
          await collectGraphqlResponseCandidates();
          const initialHydrationCount = await collectHydrationCandidates();
          // When cards are absent, keep the interactive/search-payload recovery
          // path for account variants that only expose hydration data.
          if (!args.publicOnly && args.queries.length <= 1 && !template && initialDomCount === 0 && results.length < args.limit && await triggerThreadsManualSearch(searchPage, query)) {
            await collectGraphqlResponseCandidates();
            await collectHydrationCandidates();
          }
          const effectiveScrollAttempts = initialHydrationCount > 0 ? Math.min(scrollAttempts, 2) : scrollAttempts;
          for (let attempt = 0; !template && attempt < effectiveScrollAttempts; attempt += 1) {
            if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
            await searchPage.mouse.wheel(0, 2200).catch(() => undefined);
            await searchPage.waitForTimeout(Math.min(600, remainingSentimentDeadlineMs(args.deadlineAt, 600))).catch(() => undefined);
            await collectGraphqlResponseCandidates();
          }
          if (initialHydrationCount === 0) await collectHydrationCandidates();
          await collectGraphqlResponseCandidates();
          await collectDomTextCandidates();
        } finally {
          searchPage.off("response", captureGraphqlResponse);
          await collectGraphqlResponseCandidates();
        }
      };
      if (template) {
        await page.goto(buildThreadsSearchUrl(args.queries[0] || "", recentSearch), {
          waitUntil: "domcontentloaded",
          timeout: Math.min(3_000, remainingSentimentDeadlineMs(args.deadlineAt, 3_000)),
        }).catch(() => undefined);
      } else {
        for (const bootstrapQuery of bootstrapQueries) {
          if (threadsAuthBlocked || template || (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 3_000)) break;
          // The unfiltered search page emits the reusable GraphQL request more
          // consistently. Parsed posts still pass the normal freshness checks,
          // and once captured the API payload includes real publication times.
          stats.queries += 1;
          await collectDomCandidates(page, bootstrapQuery, args.publicOnly ? 0 : THREADS_BROWSER_TEMPLATE_WAIT_ATTEMPTS, false);
        }
        if (
          args.queries.length <= 1
          && !args.publicOnly
          && !threadsAuthBlocked
          && !template
          && results.length < args.limit
        ) await rescueDetailCandidates();
      }
      if (!cachedTemplate && !args.publicOnly) page.off("request", captureTemplate);

      if (!threadsAuthBlocked && !template && results.length < args.limit) {
        const fallbackQueries = args.queries.slice(
          bootstrapQueries.length,
          THREADS_BROWSER_QUERY_LIMIT,
        );
        const fallbackPageCount = Math.min(THREADS_BROWSER_PAGE_LIMIT - 1, fallbackQueries.length);
        if (fallbackPageCount > 0 && (!args.deadlineAt || remainingSentimentDeadlineMs(args.deadlineAt, 0) >= 2_500)) {
          const extraPages = await Promise.all(Array.from({ length: fallbackPageCount }, async () => {
            const extraPage = await context.newPage().catch(() => null);
            if (!extraPage) return null;
            return extraPage;
          }));
          const usableExtraPages = extraPages.filter(Boolean);
          // The public path has no reusable GraphQL template, so keep the
          // already-open main page working in parallel with the bounded extra
          // page. This doubles distinct-tag coverage without adding another
          // renderer process.
          const usableFallbackPages = [page, ...usableExtraPages];
          stats.pages = 1 + usableExtraPages.length;
          const fallbackPlan = planThreadsBrowserDomQueryLanes(
            [bootstrapQueries[0] || "", ...fallbackQueries],
            usableFallbackPages.length,
            bootstrapQueries.length,
          );
          // Search one keyword per page first, then immediately verify the
          // queued post details. Otherwise all 30 seconds are consumed by raw
          // search volume and candidates with hidden view counts are rejected
          // before their heat can be established.
          await Promise.all(usableFallbackPages.map(async (extraPage: any, pageIndex) => {
            const query = fallbackPlan.queryLanes[pageIndex]?.[0];
            if (!query) return;
            stats.queries += 1;
            await collectDomCandidates(extraPage, query, args.publicOnly ? 0 : 3, recentSearch);
          }));
          if (!args.publicOnly && results.length < args.limit) {
            await rescueDetailCandidatesIfUseful(8_000);
          }
          await Promise.all(usableFallbackPages.map(async (extraPage: any, pageIndex) => {
            for (const query of (fallbackPlan.queryLanes[pageIndex] || []).slice(1)) {
              if (results.length >= args.limit) break;
              if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
              stats.queries += 1;
              await collectDomCandidates(extraPage, query, args.publicOnly ? 0 : 3, recentSearch);
            }
          }));
        }
      }

      if (template && !args.publicOnly) {
        const shouldPageQueries = args.limit >= 10;
        const queries = args.queries.slice(0, THREADS_BROWSER_QUERY_LIMIT);
        const searchPages: any[] = [page];
        const requestedPageCount = Math.min(THREADS_BROWSER_PAGE_LIMIT, queries.length);
        if (requestedPageCount > 1 && (!args.deadlineAt || remainingSentimentDeadlineMs(args.deadlineAt, 0) >= 4_000)) {
          const extraPages = await Promise.all(Array.from({ length: requestedPageCount - 1 }, async (_, pageIndex) => {
            const extraPage = await context.newPage().catch(() => null);
            if (!extraPage) return null;
            const warmupQuery = queries[pageIndex + 1];
            await extraPage.goto(buildThreadsSearchUrl(warmupQuery, recentSearch), {
              waitUntil: "domcontentloaded",
              timeout: Math.min(3_000, remainingSentimentDeadlineMs(args.deadlineAt, 3_000)),
            }).catch(() => undefined);
            if (String(extraPage.url?.() || "").startsWith("http")) return extraPage;
            await extraPage.close().catch(() => undefined);
            return null;
          }));
          searchPages.push(...extraPages.filter(Boolean));
          stats.pages = searchPages.length;
        }
        const processPageQueries = async (searchPage: any, pageQueries: string[], pageIndex: number) => {
          for (let offset = 0; offset < pageQueries.length && results.length < args.limit; offset += THREADS_BROWSER_QUERY_BATCH_SIZE) {
            if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
            const batch = pageQueries.slice(offset, offset + THREADS_BROWSER_QUERY_BATCH_SIZE);
            stats.queries += batch.length;
            const payloads = await Promise.all(batch.map(async (query) => ({
              query,
              payload: await requestThreadsGraphqlSearchPayload({ page: searchPage, template: template!, query, recent: recentSearch, deadlineAt: args.deadlineAt }),
            })));
            const payloadsWithNext = await Promise.all(payloads.map(async (item) => {
              const pageInfo = shouldPageQueries ? parseThreadsGraphqlSearchPageInfo(item.payload) : null;
              const nextPayload = pageInfo?.hasNextPage && pageInfo.endCursor
                && (!args.deadlineAt || remainingSentimentDeadlineMs(args.deadlineAt, 0) >= 2_000)
                ? await requestThreadsGraphqlSearchPayload({
                  page: searchPage,
                  template: template!,
                  query: item.query,
                  after: pageInfo.endCursor,
                  recent: recentSearch,
                  deadlineAt: args.deadlineAt,
                })
                : null;
              return { ...item, nextPayload };
            }));
            for (const item of payloadsWithNext) {
              const parsed = parseThreadsGraphqlSearchPayload({
                payload: item.payload,
                query: item.query,
                keywords: args.keywords,
              });
              collectGlobalPoolCandidates(parsed);
              stats.graphql += parsed.length;
              let accepted = 0;
              for (const candidate of parsed) {
                if (excluded.has(candidate.id)) continue;
                if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
                if (considerCandidate(candidate)) accepted += 1;
                if (results.length >= args.limit) break;
              }
              console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} page=${pageIndex + 1} query=${JSON.stringify(item.query)} graphql=${parsed.length} accepted=${accepted} total=${results.length}`);
              await rescueDetailCandidatesIfUseful(8_000);
              if (results.length < args.limit && item.nextPayload) {
                const nextParsed = parseThreadsGraphqlSearchPayload({
                  payload: item.nextPayload,
                  query: item.query,
                  keywords: args.keywords,
                });
                collectGlobalPoolCandidates(nextParsed);
                stats.graphql += nextParsed.length;
                let nextAccepted = 0;
                for (const candidate of nextParsed) {
                  if (excluded.has(candidate.id)) continue;
                  if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
                  if (considerCandidate(candidate)) nextAccepted += 1;
                  if (results.length >= args.limit) break;
                }
                console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} page=${pageIndex + 1} query=${JSON.stringify(item.query)} page=2 graphql=${nextParsed.length} accepted=${nextAccepted} total=${results.length}`);
                await rescueDetailCandidatesIfUseful(8_000);
              }
              if (results.length >= args.limit) break;
            }
          }
        };
        await Promise.all(searchPages.map((searchPage, pageIndex) => processPageQueries(
          searchPage,
          queries.filter((_, queryIndex) => queryIndex % searchPages.length === pageIndex),
          pageIndex,
        )));
      } else {
        console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=no_graphql_template templateStats=${JSON.stringify(templateStats)}`);
      }
      if (!threadsAuthBlocked && results.length < args.limit) await rescueDetailCandidatesIfUseful();
      await withSentimentTimeout(context.close(), 1_000, undefined);
    } finally {
      await withSentimentTimeout(browser.close().catch(() => undefined), 1_000, undefined);
    }
  } catch (error) {
    console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=error message=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    // Playwright is optional; Spider/cache/database paths still keep the Telegram flow alive.
  } finally {
    if (browserDeadlineTimer) clearTimeout(browserDeadlineTimer);
    releaseBrowserSlot();
  }
  writeGlobalSentimentHotCandidatePool([...globalPoolCandidates.values()]);
  console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=done total=${results.length} pages=${stats.pages} queries=${stats.queries} graphql=${stats.graphql} hydration=${stats.hydration} accepted=${stats.accepted} detailQueued=${stats.detailQueued} detailAttempted=${stats.detailAttempted} detailPromoted=${stats.detailPromoted} detailSkippedBudget=${stats.detailSkippedBudget} rejected=${JSON.stringify(stats.rejected)}`);
  return sortSentimentHotCandidatePool(results, args.keywords, args.limit, args.searchMode);
}

export type ThreadsSearchDateWindow = {
  afterDate: string;
  beforeDate: string;
};

export type ThreadsReaderSearchRanking = "spider-default" | "spider-ranked" | "spider-dated";

export function buildThreadsSearchDateWindow(
  freshnessDays: unknown,
  now = new Date(),
): ThreadsSearchDateWindow | undefined {
  const days = Math.round(Number(freshnessDays));
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const clamped = Math.min(30, Math.max(1, days));
  const after = new Date(now.getTime());
  after.setUTCDate(after.getUTCDate() - clamped);
  return {
    afterDate: after.toISOString().slice(0, 10),
    beforeDate: now.toISOString().slice(0, 10),
  };
}

export function buildThreadsSearchUrl(
  query: string,
  recent = false,
  serpType?: "default" | "tags",
  dateWindow?: ThreadsSearchDateWindow,
): string {
  const params = new URLSearchParams();
  // Threads only honors after_date/before_date on the ranked public search
  // (`serp_type=default`). Keep the original q=/filter= query string intact
  // when no date window is requested.
  if (dateWindow?.afterDate && dateWindow?.beforeDate) {
    params.set("after_date", dateWindow.afterDate);
    params.set("before_date", dateWindow.beforeDate);
  }
  params.set("q", String(query || ""));
  if (recent) params.set("filter", "recent");
  if (serpType) params.set("serp_type", serpType);
  return `https://www.threads.com/search?${params.toString()}`;
}

export function buildThreadsReaderSearchUrl(query: string, recentSearch = false): string {
  return buildThreadsSearchUrl(query, recentSearch === true);
}

export function buildThreadsReaderSearchTargets(
  query: string,
  recentSearch = false,
  freshnessDays = 0,
  now = new Date(),
): Array<{ query: string; targetUrl: string; ranking: ThreadsReaderSearchRanking }> {
  const text = String(query || "");
  // Keep the original two Spider HTTP rankings. When a freshness window is
  // set, add a third dated ranked URL. Live probes showed after_date only
  // changes the result set together with serp_type=default.
  const targets: Array<{ query: string; targetUrl: string; ranking: ThreadsReaderSearchRanking }> = [
    { query: text, targetUrl: buildThreadsReaderSearchUrl(text, recentSearch), ranking: "spider-default" },
    { query: text, targetUrl: buildThreadsSearchUrl(text, false, "default"), ranking: "spider-ranked" },
  ];
  const dateWindow = buildThreadsSearchDateWindow(freshnessDays, now);
  if (dateWindow) {
    targets.push({
      query: text,
      targetUrl: buildThreadsSearchUrl(text, false, "default", dateWindow),
      ranking: "spider-dated",
    });
  }
  return targets;
}

function isAllowedSpiderPublicTarget(target: URL): boolean {
  if (target.protocol !== "https:") return false;
  const host = target.hostname.replace(/^www\./i, "").toLowerCase();
  return host === "threads.com" || host === "threads.net" || host === "instagram.com";
}

const spiderRawHtmlByTargetUrl = new Map<string, string>();

function decodeSpiderHtmlEntities(value: string): string {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function spiderHtmlToReaderText(html: string, targetUrl: string): string {
  const baseUrl = new URL(targetUrl);
  const withLinks = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_full, href, label) => {
      let absoluteUrl = String(href || "");
      try { absoluteUrl = new URL(absoluteUrl, baseUrl).toString(); } catch { /* retain original */ }
      const text = decodeSpiderHtmlEntities(String(label || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      return `\n[${text || absoluteUrl}](${absoluteUrl})\n`;
    })
    .replace(/<(?:br|\/p|\/div|\/li|\/article|\/section|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeSpiderHtmlEntities(withLinks)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBalancedJsonObject(source: string, start: number, maxLen = 2_000_000): string | null {
  if (start < 0 || source[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(source.length, start + Math.max(4_000, maxLen));
  for (let index = start; index < end; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parsePrefetchSearchResultsPayload(raw: string | null): any | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const results = parsed?.data?.searchResults || parsed?.data?.search_results;
    if (!results || !Array.isArray(results.edges)) return null;
    if (!parsed.data.searchResults) parsed.data.searchResults = results;
    return parsed;
  } catch {
    return null;
  }
}

export function extractThreadsSearchPrefetchPayload(html: string): any | null {
  const source = String(html || "");
  const markers = ['{"data":{"searchResults"', '{"data":{"search_results"'];
  for (const marker of markers) {
    let from = 0;
    let fallback: any | null = null;
    while (from < source.length) {
      const start = source.indexOf(marker, from);
      if (start < 0) break;
      const parsed = parsePrefetchSearchResultsPayload(extractBalancedJsonObject(source, start));
      const edges = parsed?.data?.searchResults?.edges || parsed?.data?.search_results?.edges;
      if (Array.isArray(edges) && edges.length > 0) return parsed;
      if (!fallback && parsed) fallback = parsed;
      from = start + marker.length;
    }
    if (fallback) return fallback;
  }
  const escapedMarker = '\\"data\\":{\\"searchResults\\"';
  let escapedFrom = 0;
  while (escapedFrom < source.length) {
    const escapedStart = source.indexOf(escapedMarker, escapedFrom);
    if (escapedStart < 0) break;
    const windowStart = Math.max(0, escapedStart - 20);
    const window = source.slice(windowStart, windowStart + 2_000_000)
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
    const inner = window.indexOf('{"data":{"searchResults"');
    const parsed = parsePrefetchSearchResultsPayload(extractBalancedJsonObject(window, inner));
    if (Array.isArray(parsed?.data?.searchResults?.edges) && parsed.data.searchResults.edges.length > 0) return parsed;
    escapedFrom = escapedStart + escapedMarker.length;
  }
  return null;
}

export function extractThreadsHydrationCandidatesFromHtml(args: {
  html: string;
  query: string;
  keywords?: string[];
}): SentimentHotCandidate[] {
  const html = String(args.html || "");
  if (!html) return [];
  const byId = new Map<string, SentimentHotCandidate>();
  const add = (items: SentimentHotCandidate[]) => {
    for (const item of items) {
      if (!item?.id || byId.has(item.id)) continue;
      byId.set(item.id, item);
    }
  };
  const prefetch = extractThreadsSearchPrefetchPayload(html);
  if (prefetch) {
    add(parseThreadsGraphqlSearchPayload({
      payload: prefetch,
      query: args.query,
      keywords: args.keywords,
    }));
  }
  if (byId.size > 0) return [...byId.values()];
  for (const marker of ['{"node":{"thread"', '{"thread":{"id"', '{"post":{"id"']) {
    for (const payload of extractBalancedJsonObjectsAtMarker(html, marker, 80)) {
      add(parseThreadsGraphqlSearchPayload({
        payload,
        query: args.query,
        keywords: args.keywords,
      }));
      if (byId.size >= 40) return [...byId.values()];
    }
  }
  return [...byId.values()];
}

export function buildSpiderSearchMarkdownFromHotCandidates(candidates: SentimentHotCandidate[]): string {
  const cards = (candidates || []).map((candidate) => {
    const published = String(candidate.publishedAt || "").slice(0, 10);
    const dateLabel = published.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1") || "post";
    const likes = Number(candidate.engagement?.likeCount || (candidate.metrics as any)?.like_count || 0);
    const comments = Number(candidate.engagement?.commentCount || (candidate.metrics as any)?.comment_count || 0);
    const mediaLines = (candidate.media || [])
      .map((item, index) => {
        const url = cleanText(item?.url);
        if (!url) return "";
        const alt = item.type === "video" ? `Video ${index + 1}` : `Image ${index + 1}`;
        return `![${alt}](${url})`;
      })
      .filter(Boolean);
    return [
      `[${candidate.author || "Threads"}](https://www.threads.com/@${encodeURIComponent(String(candidate.author || "").replace(/^@/, ""))})`,
      `[${dateLabel}](${candidate.sourceUrl})`,
      candidate.content,
      ...mediaLines,
      likes ? `讚 ${likes}` : "",
      comments ? `留言 ${comments}` : "",
    ].filter(Boolean).join("\n");
  }).filter(Boolean);
  return formatPublicThreadsReaderMarkdown(cards.join("\n\n"));
}

export function readSpiderHydrationScripts(targetUrl: string): string[] {
  const html = spiderRawHtmlByTargetUrl.get(targetUrl) || "";
  if (!html) return [];
  const scripts: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = String(match[1] || "").trim();
    if (text.includes("text_post_app_info") || text.includes('"like_count"') || text.includes("searchResults")) scripts.push(text);
  }
  const prefetch = extractThreadsSearchPrefetchPayload(html);
  if (prefetch) scripts.unshift(JSON.stringify(prefetch));
  return scripts;
}

export function readerMarkdownLooksEmpty(body: unknown): boolean {
  const text = String(body || "").trim();
  if (!text) return true;
  if (readerBodyLooksLikeLoginWall(text)) return true;
  if (threadsHtmlLooksLikeEmptySearch(text)) return true;
  if (readerBodyHasUsablePostLinks(text)) return false;
  return /^(?:title:\s*)?(?:search\s*•\s*threads|search threads|threads\s*•\s*log in|threads)\s*$/i.test(text);
}

export function formatPublicThreadsReaderMarkdown(text: string): string {
  const rewritten = String(text || "").replace(
    /\[(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\]\((https?:\/\/(?:www\.)?threads\.(?:com|net)\/@[^)\s]+\/post\/[^)\s]+)\)/g,
    (_full, year, month, day, url) => `[${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}](${url})`,
  ).trim();
  if (!rewritten) return "";
  return /search\s*•\s*threads|search threads/i.test(rewritten) ? rewritten : `Search • Threads\n\n${rewritten}`;
}

export function persistSentimentReaderMarkdown(targetUrl: string, markdown: string, extra: Record<string, string> = {}): string {
  const digest = crypto.createHash("sha256").update(String(targetUrl || "")).digest("hex").slice(0, 16);
  const filePath = resolveRuntimeFile(path.join("sentiment_reader_markdown", `${digest}.md`));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = [
    "---",
    `url: ${String(targetUrl || "").replace(/\n/g, " ")}`,
    `capturedAt: ${new Date().toISOString()}`,
    ...Object.entries(extra).map(([key, value]) => `${key}: ${String(value || "").replace(/\n/g, " ")}`),
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(filePath, `${header}${String(markdown || "").trim()}\n`, "utf8");
  return filePath;
}

function playwrightProxyFromReaderUrl(proxyUrl?: string): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    return {
      server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  } catch {
    return undefined;
  }
}

function buildPublicReaderChromiumLaunchOptions(proxyUrl?: string) {
  const executablePath = resolvePreferredChromeExecutablePath();
  const proxy = playwrightProxyFromReaderUrl(proxyUrl);
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxy ? { proxy } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
}

const activeSpiderProcesses = new Set<ChildProcess>();

export async function shutdownSentimentSpiderProcesses(timeoutMs = 1_500): Promise<void> {
  for (const child of activeSpiderProcesses) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  const deadlineAt = Date.now() + Math.max(0, timeoutMs);
  while (activeSpiderProcesses.size > 0 && Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runSpiderProcess(args: {
  targetUrl: string;
  proxyUrl?: string;
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
  cliArgs: string[];
}): Promise<any> {
  if (args.signal?.aborted) throw args.signal.reason;
  const output = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let abort: () => void = () => undefined;
    const child = execFile(SPIDER_HTTP_CLI_PATH, args.cliArgs, {
      encoding: "utf8",
      timeout: Math.max(1_000, Math.floor(args.timeoutMs)),
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", RUST_LOG: "error" },
    }, (error, stdout, stderr) => {
      activeSpiderProcesses.delete(child);
      if (args.signal) args.signal.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (error) {
        const detail = String(stderr || "").trim().slice(-240);
        reject(new Error(`Spider scrape failed: ${error.message}${detail ? ` (${detail})` : ""}`));
        return;
      }
      resolve(String(stdout || ""));
    });
    activeSpiderProcesses.add(child);
    abort = () => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      reject(args.signal?.reason instanceof Error ? args.signal.reason : new Error("Spider scrape aborted"));
    };
    if (args.signal) {
      args.signal.addEventListener("abort", abort, { once: true });
      if (args.signal.aborted) abort();
    }
    child.once("close", () => activeSpiderProcesses.delete(child));
  });
  const trimmed = String(output || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    if (/^</.test(trimmed)) return { content: trimmed, status_code: 200 };
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    throw new Error("Spider scrape returned non-JSON output");
  }
}

async function runSpiderMarkdownReader(args: {
  targetUrl: string;
  proxyUrl?: string;
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ReaderResponseSnapshot> {
  const target = new URL(args.targetUrl);
  if (!isAllowedSpiderPublicTarget(target)) {
    throw new Error("Spider public crawler only accepts HTTPS Threads or Instagram targets");
  }
  const payload = await runSpiderProcess({
    ...args,
    cliArgs: [
      "--url", target.toString(),
      "--http",
      "--limit", "1",
      "--depth", "1",
      "--agent", args.userAgent,
      ...(args.proxyUrl ? ["--proxy-url", args.proxyUrl] : []),
      "--return-format", "raw",
      "scrape",
      "--output-html",
    ],
  });
  const rawHtml = String(payload?.content || "");
  spiderRawHtmlByTargetUrl.set(target.toString(), rawHtml);
  while (spiderRawHtmlByTargetUrl.size > 40) spiderRawHtmlByTargetUrl.delete(spiderRawHtmlByTargetUrl.keys().next().value as string);
  const query = target.searchParams.get("q") || "";
  const prefetchedCandidates = extractThreadsHydrationCandidatesFromHtml({
    html: rawHtml,
    query,
    keywords: [],
  });
  const markdown = prefetchedCandidates.length
    ? buildSpiderSearchMarkdownFromHotCandidates(prefetchedCandidates)
    : formatPublicThreadsReaderMarkdown(spiderHtmlToReaderText(rawHtml, target.toString()));
  const status = Math.floor(Number(payload?.status_code || 0));
  const usable = prefetchedCandidates.length > 0 || readerBodyHasUsablePostLinks(markdown);
  const emptySearch = threadsHtmlLooksLikeEmptySearch(rawHtml) || threadsHtmlLooksLikeEmptySearch(markdown);
  const loginWall = !usable && !emptySearch && (readerBodyLooksLikeLoginWall(markdown) || readerBodyLooksLikeLoginWall(rawHtml));
  const empty = !usable && (emptySearch || readerMarkdownLooksEmpty(markdown));
  const boundary = loginWall ? "login_wall" : empty ? "empty" : prefetchedCandidates.length ? "prefetch" : usable ? "html" : "empty";
  persistSentimentReaderMarkdown(target.toString(), markdown, {
    crawler: prefetchedCandidates.length ? "spider-prefetch-markdown" : "spider-markdown",
    posts: String(prefetchedCandidates.length),
    boundary,
  });
  const ok = status >= 200 && status < 300 && usable && !loginWall && !empty;
  return {
    ok,
    status: loginWall ? 401 : empty && status >= 200 && status < 300 ? 204 : status,
    headers: {
      "content-type": prefetchedCandidates.length ? "text/markdown; spider-reader=prefetch" : "text/markdown; spider-reader=html",
      "x-public-crawler": "spider-cli/2.52.9",
      "x-spider-boundary": boundary,
    },
    body: markdown,
  };
}

async function renderPublicPageToMarkdown(args: {
  targetUrl: string;
  proxyUrl?: string;
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ReaderResponseSnapshot> {
  const target = new URL(args.targetUrl);
  if (args.signal?.aborted) throw args.signal.reason;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(buildPublicReaderChromiumLaunchOptions(args.proxyUrl));
  try {
    const context = await browser.newContext({
      locale: "zh-TW",
      userAgent: args.userAgent,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const gotoTimeout = Math.max(5_000, Math.min(16_000, Math.floor(args.timeoutMs)));
    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: gotoTimeout });
    await page.waitForSelector('a[href*="/post/"], a[href*="/t/"]', { timeout: Math.min(8_000, gotoTimeout) }).catch(() => undefined);
    await page.waitForTimeout(Math.min(1_800, Math.max(400, gotoTimeout - 3_000))).catch(() => undefined);
    const extracted = await page.evaluate(() => {
      const cards: Array<{ author: string; href: string; date: string; content: string; likes: string; comments: string }> = [];
      const seen = new Set<string>();
      const han = (value: string) => (value.match(/[\u3400-\u9fff]/g) || []).length;
      for (const anchor of Array.from(document.querySelectorAll('a[href*="/post/"]'))) {
        const hrefAttr = String((anchor as HTMLAnchorElement).getAttribute("href") || (anchor as HTMLAnchorElement).href || "");
        let href = hrefAttr;
        try { href = new URL(hrefAttr, location.origin).href; } catch { /* keep original */ }
        const match = href.match(/https?:\/\/(?:www\.)?threads\.(?:com|net)\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/i);
        if (!match || /\/media\/?$/i.test(href)) continue;
        const key = `${match[1]}/${match[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let root = anchor.parentElement as HTMLElement | null;
        for (let depth = 0; depth < 10 && root; depth += 1) {
          const sample = String(root.innerText || "");
          if (han(sample) >= 20 || /讚\s*\d|赞\s*\d/.test(sample) || root.getAttribute("role") === "article") break;
          root = root.parentElement;
        }
        const raw = String(root?.innerText || "").replace(/\u00a0/g, " ");
        const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const content = lines
          .filter((line) => han(line) >= 8)
          .filter((line) => !/^(?:翻譯|翻译|Translate|无法显示贴文|無法顯示貼文)$/i.test(line))
          .slice(0, 4)
          .join(" ");
        const numbers = lines.map((line) => line.replace(/,/g, "")).filter((line) => /^\d+(?:\.\d+)?[万萬千kKmM]?$/.test(line));
        const dateLine = lines.find((line) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(line)) || "";
        cards.push({
          author: match[1],
          href: `https://www.threads.com/@${match[1]}/post/${match[2]}`,
          date: dateLine,
          content: content.slice(0, 800),
          likes: numbers[0] || "",
          comments: numbers[1] || "",
        });
      }
      return cards;
    }).catch(() => [] as Array<{ author: string; href: string; date: string; content: string; likes: string; comments: string }>);
    const html = await page.content();
    spiderRawHtmlByTargetUrl.set(target.toString(), html);
    while (spiderRawHtmlByTargetUrl.size > 40) spiderRawHtmlByTargetUrl.delete(spiderRawHtmlByTargetUrl.keys().next().value as string);
    const structured = extracted.length
      ? extracted.map((card) => {
        const dateLabel = card.date.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_full, year, month, day) => {
          return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
        }) || "post";
        return [
          `[${card.author}](https://www.threads.com/@${card.author})`,
          `[${dateLabel}](${card.href})`,
          card.content,
          card.likes,
          card.comments,
        ].filter(Boolean).join("\n");
      }).join("\n\n")
      : spiderHtmlToReaderText(html, target.toString());
    const markdown = formatPublicThreadsReaderMarkdown(structured);
    persistSentimentReaderMarkdown(target.toString(), markdown, { crawler: "spider-public-render" });
    return {
      ok: true,
      status: 200,
      headers: { "content-type": "text/markdown; spider-reader=public-render", "x-public-crawler": "spider-cli/2.52.9" },
      body: markdown,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function isCacheableSentimentReaderResponse(value: ReaderResponseSnapshot): boolean {
  return value.ok
    && value.status >= 200
    && value.status < 300
    && value.body.trim().length > 0
    && readerBodyHasUsablePostLinks(value.body)
    && !readerMarkdownLooksEmpty(value.body)
    && !/<title>\s*(?:502|503|504)\b|bad gateway|gateway timeout|service unavailable/i.test(value.body)
    && !readerBodyLooksLikeLoginWall(value.body);
}

export async function fetchWithSharedPublicCrawlerLimit(
  targetUrl: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
  cacheMode: ReaderResponseCacheMode = "swr",
): Promise<{
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
}> {
  const anonymousProxyPool = readAnonymousReaderProxyPool();
  // Do not append a synthetic parameter to the Threads target URL. Threads
  // treats that otherwise harmless parameter as a different public route and
  // frequently responds with a login-only page. No-cache headers below are
  const requestHeaders = new Headers(init.headers);
  const cacheKey = JSON.stringify({
    // Never reuse entries written by the retired hosted Reader path.
    schema: "spider-prefetch-response-v1",
    url: targetUrl,
    method: String(init.method || "GET").toUpperCase(),
    accept: requestHeaders.get("accept") || "",
    anonymousProxy: anonymousProxyPool.required ? `enabled:${anonymousProxyPool.revision}` : "disabled",
    crawler: "spider-cli-2.52.9-markdown",
  });
  const snapshot = await sharedReaderResponseCoordinator.getOrLoad(
    cacheKey,
    async (): Promise<ReaderResponseSnapshot> => {
      let lastError: unknown;
      let lastSnapshot: ReaderResponseSnapshot | null = null;
      const maxAttempts = resolveAnonymousReaderMaxAttempts();
      // Every request picks the next verified public proxy product. The
      // authenticated account pool and its sticky proxies are never touched.
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        // Interactive jobs keep jitter under 200ms so 24 keyword searches
        // start together. Refill keeps the wider 1-5s burst spacing.
        await new Promise((resolve) => setTimeout(resolve, resolveAnonymousReaderJitterMs()));
        try {
          const current = await sharedReaderRateLimiter.run(
            SHARED_READER_UPSTREAM_KEY,
            async ({ signal }) => {
              const activeProxyPool = readAnonymousReaderProxyPool();
              const anonymousProxy = takeNextAnonymousReaderProxy(activeProxyPool);
              if (activeProxyPool.required && !anonymousProxy) {
                throw new Error("Spider proxy pool is enabled but has no verified active product");
              }
              if (signal.aborted) throw signal.reason;
              const viaProxy = await runSpiderMarkdownReader({
                targetUrl,
                proxyUrl: anonymousProxy?.url,
                userAgent: requestHeaders.get("user-agent") || "Mozilla/5.0",
                timeoutMs,
                signal,
              });
              const proxyDead = Boolean(anonymousProxy) && (
                !viaProxy.ok
                || [401, 403, 407, 451, 502, 503, 504, 204].includes(Math.floor(Number(viaProxy.status || 0)))
                || Boolean(anonymousReaderRetryReason(viaProxy))
              );
              if (!proxyDead) return viaProxy;
              console.info(`[sentiment_hot_reader_failover] reason=proxy_${viaProxy.status || "empty"}_direct_fallback`);
              return runSpiderMarkdownReader({
                targetUrl,
                userAgent: requestHeaders.get("user-agent") || "Mozilla/5.0",
                timeoutMs,
                signal,
              });
            },
            { timeoutMs },
          );
          lastSnapshot = current;
          const retryReason = anonymousReaderRetryReason(current);
          if (!retryReason || attempt >= maxAttempts - 1) return current;
          console.info(`[sentiment_hot_reader_failover] reason=${retryReason} attempt=${attempt + 1} proxy_failover=1`);
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts - 1 || !isRetryableAnonymousReaderError(error)) throw error;
          console.info(`[sentiment_hot_reader_failover] reason=network_or_timeout attempt=${attempt + 1} proxy_failover=1`);
        }
      }
      if (lastSnapshot) return lastSnapshot;
      throw lastError instanceof Error ? lastError : new Error("Spider HTTP request failed after proxy rotation");
    },
    {
      mode: cacheMode,
      isCacheable: isCacheableSentimentReaderResponse,
    },
  );
  return {
    ok: snapshot.ok,
    status: snapshot.status,
    headers: new Headers(snapshot.headers),
    text: async () => snapshot.body,
  };
}

async function fetchThreadsReaderSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  refresh?: boolean;
  excludeIds?: Set<string>;
  freshnessDays?: number;
  searchMode?: SentimentHotSearchMode;
  deadlineAt?: number;
  recentSearch?: boolean;
  deferRelevanceGate?: boolean;
}): Promise<SentimentHotCandidate[]> {
  const excluded = args.excludeIds || (args.refresh ? getSentimentHotRefreshExcludedIds(args.archiveId) : getSentimentHotExcludedIds(args.archiveId));
  const all: SentimentHotCandidate[] = [];
  const allKeys = new Set<string>();
  const globalPoolCandidates = new Map<string, SentimentHotCandidate>();
  const consumeSearches = (searches: Array<{ query: string; targetUrl: string; text: string }>) => {
    for (const search of searches) {
      const parsedMarkdown = parseThreadsReaderSearchMarkdownCandidates({
        text: search.text,
        query: search.query,
        keywords: args.keywords,
        includeUnmatched: true,
        sourceUrl: search.targetUrl,
        limit: Math.max(50, args.limit * 5),
      });
      const parsedHydration = parseThreadsSearchHydrationPayloads({
        scripts: readSpiderHydrationScripts(search.targetUrl),
        query: search.query,
        keywords: args.keywords,
      }).map((candidate) => ({
        ...candidate,
        // Preserve the public Reader source contract used by relevance and
        // concise-post quality gates. Record Spider as the crawler detail,
        // not as a new business source tier.
        metrics: {
          ...(candidate.metrics || {}),
          source: "threads-reader-search",
          crawler: "spider-http-hydration",
          publicSearch: true,
        },
      }));
      const parsedById = new Map<string, SentimentHotCandidate>();
      for (const candidate of parsedMarkdown) parsedById.set(candidate.id, candidate);
      for (const candidate of parsedHydration) {
        const existing = parsedById.get(candidate.id);
        if (!existing) {
          parsedById.set(candidate.id, candidate);
          continue;
        }
        parsedById.set(candidate.id, {
          ...existing,
          ...candidate,
          content: cleanSentimentCandidateContent(existing.content || candidate.content),
          media: mergeCandidateMedia(existing.media || [], candidate.media || []),
          engagement: {
            ...(existing.engagement || {}),
            ...(candidate.engagement || {}),
          },
          metrics: {
            ...(existing.metrics || {}),
            ...(candidate.metrics || {}),
            mediaCount: mergeCandidateMedia(existing.media || [], candidate.media || []).length,
          },
        });
      }
      const parsed = [...parsedById.values()];
      for (const candidate of parsed) globalPoolCandidates.set(candidate.id, candidate);
      const collectCap = Math.max(args.limit * 3, 30);
      for (const candidate of parsed) {
        if (all.length >= collectCap) continue;
        if (excluded.has(candidate.id)) continue;
        const normalized = candidateMeetsDisplayQuality(
          candidate,
          args.deferRelevanceGate ? [] : args.keywords,
          args.searchMode,
          args.freshnessDays,
        );
        if (!normalized) continue;
        const dedupeKey = sentimentCandidateDedupeKey(normalized);
        if (all.some((item) => item.id === normalized.id) || allKeys.has(dedupeKey)) continue;
        allKeys.add(dedupeKey);
        all.push(stampHotCandidateOrigin(normalized, "live_spider"));
      }
    }
  };
  // Spider HTTP is the only public crawler. It never starts Chromium and never
  // calls a hosted Reader. Wave 1 is relevance search (`q=`). Wave 2 is the
  // complementary high-engagement ranking (`serp_type=default`) plus an extra
  // dated ranked branch when freshnessDays is set. The first two URLs stay
  // unchanged so the original fetch chain is preserved.
  const readerTargets = args.queries.map((query) => (
    buildThreadsReaderSearchTargets(query, args.recentSearch, args.freshnessDays)
  ));
  const searchWaves = [
    readerTargets.map((targets) => targets[0]),
    readerTargets.flatMap((targets) => targets.slice(1)),
  ];
  const collectCap = Math.max(args.limit * 3, 30);
  const fetchOneSearch = async (target: { query: string; targetUrl: string; ranking: ThreadsReaderSearchRanking }) => {
    try {
      const parsed = new URL(target.targetUrl);
      if (!isAllowedSpiderPublicTarget(parsed)) return { ...target, text: "" };
      const timeoutMs = Math.min(8_000, remainingSentimentDeadlineMs(args.deadlineAt, 8_000));
      if (timeoutMs < 1_000) return { ...target, text: "" };
      const response = await fetchWithSharedPublicCrawlerLimit(target.targetUrl, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,text/markdown,text/plain,*/*",
          "cache-control": "max-age=300",
        },
      }, timeoutMs, args.refresh ? "blocking-refresh" : "swr");
      const text = response.ok ? await response.text() : "";
      if (!text || readerMarkdownLooksEmpty(text) || readerBodyLooksLikeLoginWall(text)) {
        return { ...target, text: "" };
      }
      return { ...target, text };
    } catch {
      return { ...target, text: "" };
    }
  };
  for (const [waveIndex, wave] of searchWaves.entries()) {
    if (all.length >= collectCap) break;
    if (waveIndex > 0 && args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 4_000) break;
    for (let offset = 0; offset < wave.length; offset += THREADS_READER_QUERY_BATCH_SIZE) {
      if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
      const targetBatch = wave.slice(offset, offset + THREADS_READER_QUERY_BATCH_SIZE);
      const waveLabel = waveIndex === 0
        ? "spider-default"
        : targetBatch.some((target) => target.ranking === "spider-dated")
          ? "spider-ranked+dated"
          : "spider-ranked";
      console.info(`[sentiment_hot_reader_search] archiveId=${args.archiveId} concurrent=${targetBatch.length} wave=${waveLabel} offset=${offset} have=${all.length} mode=spider-http`);
      await Promise.all(targetBatch.map(async (target) => {
        const search = await fetchOneSearch(target);
        consumeSearches([search]);
      }));
      if (all.length >= collectCap) break;
    }
  }
  writeGlobalSentimentHotCandidatePool([...globalPoolCandidates.values()]);
  console.info(`[sentiment_hot_reader_search] archiveId=${args.archiveId} status=done accepted=${all.length} mode=spider-http`);
  return args.deferRelevanceGate
    ? sortUsefulHotCandidates(all, collectCap)
    : sortSentimentHotCandidatePool(all, args.keywords, collectCap, args.searchMode);
}

export function parseInstagramAuthenticatedSearchPayload(args: {
  payload: any;
  query: string;
  keywords?: string[];
}): SentimentHotCandidate[] {
  const out: SentimentHotCandidate[] = [];
  const seenIds = new Set<string>();
  const stack: any[] = [args.payload];
  const visited = new Set<any>();
  const needles = buildRelevanceNeedles([args.query, ...(args.keywords || [])]);
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value)) {
      const username = cleanText(value?.user?.username || value?.owner?.username).replace(/^@+/, "");
      const code = cleanText(value?.code || value?.shortcode);
      const content = cleanSentimentCandidateContent(
        value?.caption?.text
        || value?.caption_text
        || value?.edge_media_to_caption?.edges?.[0]?.node?.text
        || value?.accessibility_caption
        || "",
      );
      const publishedAt = normalizeThreadsTimestamp(value?.taken_at ?? value?.taken_at_timestamp);
      if (username && code && content && publishedAt) {
        const likeCount = Math.max(0, Number(
          value?.like_count
          ?? value?.likeCount
          ?? value?.edge_liked_by?.count
          ?? value?.edge_media_preview_like?.count
        ) || 0);
        const commentCount = Math.max(0, Number(
          value?.comment_count
          ?? value?.commentCount
          ?? value?.edge_media_to_comment?.count
        ) || 0);
        const rawViewCount = [
          value?.play_count,
          value?.view_count,
          value?.video_view_count,
        ].find((item) => item !== null && item !== undefined && item !== "");
        const viewCount = rawViewCount === undefined ? undefined : Math.max(0, Number(rawViewCount) || 0);
        const sourceUrl = `https://www.instagram.com/p/${encodeURIComponent(code)}/`;
        const id = buildSentimentCandidateId({ platform: "instagram", sourceUrl, content });
        if (!seenIds.has(id)) {
          seenIds.add(id);
          const haystack = [content, username].join(" ").toLowerCase();
          const matchedKeywords = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
          const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {
            likeCount,
            commentCount,
            rawSignals: [likeCount, commentCount],
          };
          if (typeof viewCount === "number") engagement.viewCount = viewCount;
          const hotScore = realSentimentHotScore(engagement);
          out.push({
            id,
            platform: "instagram",
            sourceUrl,
            author: username,
            content,
            media: extractThreadsGraphqlPostMedia(value),
            hotScore,
            metrics: {
              source: "instagram-account-search",
              query: args.query,
              matchedKeywords,
              like_count: likeCount,
              comment_count: commentCount,
              ...(typeof viewCount === "number" ? { view_count: viewCount } : {}),
              realEngagementTotal: hotScore,
            },
            engagement,
            publishedAt,
            capturedAt: new Date().toISOString(),
            warnings: [],
          });
        }
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return out;
}

function normalizeInstagramAuthenticatedTagQuery(value: unknown): string {
  return cleanText(value)
    .replace(/^#+/, "")
    .replace(/[\s#，、。.!！？?;；:：/\\|()[\]{}]+/g, "")
    .slice(0, 24);
}

async function fetchInstagramAuthenticatedSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  freshnessDays: number;
  searchMode: SentimentHotSearchMode;
  excludeIds?: Set<string>;
  deadlineAt?: number;
  warnings?: string[];
}): Promise<SentimentHotCandidate[]> {
  const cookies = readSentimentBrowserAuthCookies("instagram")
    .map((cookie: any) => normalizeCookieForBrowserAuth(cookie, "instagram.com"))
    .filter(Boolean);
  if (!hasValidInstagramSessionCookie(cookies)) {
    console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} status=skip_no_session cookies=${cookies.length}`);
    return [];
  }
  const queries = [...new Set(args.queries
    .map(normalizeInstagramAuthenticatedTagQuery)
    .filter((query) => query.length >= 2 && hasHan(query)))]
    .slice(0, INSTAGRAM_AUTHENTICATED_QUERY_LIMIT);
  if (!queries.length) return [];
  console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} status=waiting_slot queries=${queries.length}`);
  const releaseBrowserSlot = await acquireSentimentBrowserWorkSlot();
  console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} status=start queries=${queries.length}`);

  const excluded = args.excludeIds || getSentimentHotRefreshExcludedIds(args.archiveId);
  const results: SentimentHotCandidate[] = [];
  const resultKeys = new Set<string>();
  const globalPoolCandidates = new Map<string, SentimentHotCandidate>();
  const stats = { requests: 0, ok: 0, failed: 0, rateLimited: 0, unauthorized: 0, graphql: 0, parsed: 0, accepted: 0, rejected: {} as Record<string, number> };
  const considerCandidate = (candidate: SentimentHotCandidate) => {
    if (excluded.has(candidate.id)) return;
    const normalized = candidateMeetsDisplayQuality(
      candidate,
      args.keywords,
      args.searchMode,
      args.freshnessDays,
      stats.rejected,
    );
    if (!normalized) return;
    const dedupeKey = sentimentCandidateDedupeKey(normalized);
    if (resultKeys.has(dedupeKey) || results.some((entry) => entry.id === normalized!.id)) return;
    resultKeys.add(dedupeKey);
    results.push(normalized);
    stats.accepted += 1;
  };

  let browser: any = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch(buildLocalChromiumLaunchOptions());
    const context = await browser.newContext({
      locale: "zh-TW",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    await addCookiesBestEffort(context, cookies as any[]);
    const page = await context.newPage();
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: Math.min(10_000, remainingSentimentDeadlineMs(args.deadlineAt, 10_000)),
    }).catch(() => null);
    console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} status=origin_ready url=${JSON.stringify(String(page.url?.() || ""))}`);
    let instagramKeywordSearchBlocked = false;
    const triggerInstagramKeywordSearch = async (query: string) => {
      if (instagramKeywordSearchBlocked) return false;
      if (!query || results.length >= args.limit) return false;
      if (remainingSentimentDeadlineMs(args.deadlineAt, 0) < 3_000) return false;
      try {
        await page.goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(5_000, remainingSentimentDeadlineMs(args.deadlineAt, 5_000)),
        }).catch(() => undefined);
        await page.waitForTimeout(Math.min(700, remainingSentimentDeadlineMs(args.deadlineAt, 700))).catch(() => undefined);
        const currentUrl = String(page.url?.() || "");
        if (/\/accounts\/login\//i.test(currentUrl)) {
          instagramKeywordSearchBlocked = true;
          console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} source=instagram_keyword_search status=login_wall query=${JSON.stringify(query)} url=${JSON.stringify(currentUrl)}`);
          return false;
        }
        const selectors = [
          'input[placeholder*="Search"]',
          'input[placeholder*="搜尋"]',
          'input[placeholder*="搜索"]',
          'input[aria-label*="Search"]',
          'input[aria-label*="搜尋"]',
          'input[aria-label*="搜索"]',
          'input[type="text"]',
        ];
        for (const selector of selectors) {
          const input = page.locator(selector).first();
          const visible = await input.isVisible({ timeout: 400 }).catch(() => false);
          if (!visible) continue;
          await input.click({ timeout: 800 }).catch(() => undefined);
          await input.fill(query, { timeout: 1_000 }).catch(async () => {
            await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
            await page.keyboard.type(query, { delay: 8 }).catch(() => undefined);
          });
          await page.waitForTimeout(Math.min(900, remainingSentimentDeadlineMs(args.deadlineAt, 900))).catch(() => undefined);
          await input.press("Enter", { timeout: 800 }).catch(() => page.keyboard.press("Enter").catch(() => undefined));
          await page.waitForTimeout(Math.min(900, remainingSentimentDeadlineMs(args.deadlineAt, 900))).catch(() => undefined);
          break;
        }
        console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} source=instagram_keyword_search query=${JSON.stringify(query)} url=${JSON.stringify(String(page.url?.() || ""))}`);
        return true;
      } catch {
        return false;
      }
    };
    for (const tag of queries.slice(0, INSTAGRAM_GRAPHQL_PAGE_QUERY_LIMIT)) {
      if (results.length >= args.limit || remainingSentimentDeadlineMs(args.deadlineAt, 0) < 5_000) break;
      const beforeParsed = stats.parsed;
      const beforeAccepted = stats.accepted;
      const responseTasks: Array<Promise<void>> = [];
      const onGraphqlResponse = (response: any) => {
        try {
          const url = String(response.url?.() || response.url || "");
          if (!/(?:\/api\/graphql|\/graphql\/query)(?:[/?]|$)/i.test(url)) return;
          const status = Number(response.status?.() || response.status || 0);
          if (status === 429) stats.rateLimited += 1;
          if (status === 401 || status === 403) stats.unauthorized += 1;
          if (status < 200 || status >= 300) return;
          responseTasks.push((async () => {
            const text = await withSentimentTimeout(response.text().catch(() => ""), 4_000, "");
            const parsed = parseInstagramAuthenticatedSearchPayload({
              payload: safeJson(text),
              query: tag,
              keywords: args.keywords,
            });
            for (const candidate of parsed) globalPoolCandidates.set(candidate.id, candidate);
            stats.graphql += parsed.length;
            stats.parsed += parsed.length;
            parsed.forEach(considerCandidate);
          })());
        } catch {
          // Ignore a single noisy response and keep collecting the page.
        }
      };
      page.on("response", onGraphqlResponse);
      if (queries.indexOf(tag) < INSTAGRAM_KEYWORD_SEARCH_PAGE_QUERY_LIMIT) {
        await triggerInstagramKeywordSearch(tag);
        await page.waitForTimeout(Math.min(2_500, remainingSentimentDeadlineMs(args.deadlineAt, 2_500))).catch(() => undefined);
        await withSentimentTimeout(Promise.all(responseTasks.splice(0, responseTasks.length)).then(() => undefined), 2_000, undefined);
      }
      await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(8_000, remainingSentimentDeadlineMs(args.deadlineAt, 8_000)),
      }).catch(() => undefined);
      await page.waitForTimeout(Math.min(1_500, remainingSentimentDeadlineMs(args.deadlineAt, 1_500))).catch(() => undefined);
      await page.mouse.wheel(0, 2400).catch(() => undefined);
      await page.waitForTimeout(Math.min(1_000, remainingSentimentDeadlineMs(args.deadlineAt, 1_000))).catch(() => undefined);
      page.off("response", onGraphqlResponse);
      await withSentimentTimeout(Promise.all(responseTasks).then(() => undefined), 2_000, undefined);
      console.info(
        `[sentiment_hot_instagram_account_search] archiveId=${args.archiveId}`
        + ` tag_graphql=${JSON.stringify(tag)} parsed=${stats.parsed - beforeParsed}`
        + ` accepted=${stats.accepted - beforeAccepted} total=${results.length}`,
      );
    }
    const directApiEnd = Math.min(queries.length, INSTAGRAM_GRAPHQL_PAGE_QUERY_LIMIT + INSTAGRAM_DIRECT_TAG_API_QUERY_LIMIT);
    for (let offset = INSTAGRAM_GRAPHQL_PAGE_QUERY_LIMIT; offset < directApiEnd && results.length < args.limit; offset += INSTAGRAM_AUTHENTICATED_QUERY_BATCH_SIZE) {
      if (remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
      if (stats.rateLimited > 0) {
        console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} status=skip_api_batch_after_rate_limit retrying=0`);
        break;
      }
      const batch = queries.slice(offset, offset + INSTAGRAM_AUTHENTICATED_QUERY_BATCH_SIZE);
      stats.requests += batch.length;
      const requestTimeoutMs = Math.min(3_500, remainingSentimentDeadlineMs(args.deadlineAt, 3_500));
      const responses = await Promise.all(batch.map(async (tag) => {
        try {
          return await withSentimentTimeout(instagramAuthenticatedRateLimiter.run(
            INSTAGRAM_AUTH_UPSTREAM_KEY,
            async ({ signal }) => {
              if (signal.aborted) throw signal.reason;
              const result = await withSentimentTimeout(
                page.evaluate(async ({ tag, timeoutMs }: { tag: string; timeoutMs: number }) => {
                  const controller = new AbortController();
                  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                  try {
                    const response = await fetch(`/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tag)}`, {
                      credentials: "include",
                      headers: {
                        accept: "*/*",
                        "x-ig-app-id": "936619743392459",
                        "x-requested-with": "XMLHttpRequest",
                      },
                      signal: controller.signal,
                    });
                    return {
                      tag,
                      ok: response.ok,
                      status: response.status,
                      retryAfter: response.headers.get("retry-after") || "",
                      text: response.ok ? await response.text() : "",
                    };
                  } catch {
                    return { tag, ok: false, status: 0, retryAfter: "", text: "" };
                  } finally {
                    clearTimeout(timeoutId);
                  }
                }, { tag, timeoutMs: requestTimeoutMs }),
                requestTimeoutMs + 500,
                { tag, ok: false, status: 0, retryAfter: "", text: "" },
              );
              return {
                ...result,
                headers: { "retry-after": result.retryAfter },
              };
            },
            { timeoutMs: requestTimeoutMs },
          ), requestTimeoutMs + 1_000, { tag, ok: false, status: 0, retryAfter: "", text: "" });
        } catch {
          return { tag, ok: false, status: 0, retryAfter: "", text: "" };
        }
      }));
      for (const response of responses) {
        if (!response.ok) {
          stats.failed += 1;
          if (response.status === 429) stats.rateLimited += 1;
          if (response.status === 401 || response.status === 403) stats.unauthorized += 1;
          continue;
        }
        stats.ok += 1;
        const parsed = parseInstagramAuthenticatedSearchPayload({
          payload: safeJson(response.text),
          query: response.tag,
          keywords: args.keywords,
        });
        for (const candidate of parsed) globalPoolCandidates.set(candidate.id, candidate);
        stats.parsed += parsed.length;
        parsed.forEach(considerCandidate);
      }
      console.info(
        `[sentiment_hot_instagram_account_search] archiveId=${args.archiveId}`
        + ` batch=${Math.floor(offset / INSTAGRAM_AUTHENTICATED_QUERY_BATCH_SIZE) + 1}`
        + ` requests=${stats.requests} ok=${stats.ok} parsed=${stats.parsed} accepted=${stats.accepted}`
        + ` rejected=${JSON.stringify(stats.rejected)}`,
      );
      if (stats.rateLimited > 0) break;
    }
    await context.close().catch(() => undefined);
  } catch (error) {
    console.info(`[sentiment_hot_instagram_account_search] archiveId=${args.archiveId} status=error error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
  } finally {
    await browser?.close?.().catch(() => undefined);
    releaseBrowserSlot();
  }
  console.info(
    `[sentiment_hot_instagram_account_search] archiveId=${args.archiveId}`
    + ` sessionid=1 queries=${queries.length} requests=${stats.requests} ok=${stats.ok}`
    + ` failed=${stats.failed} rateLimited=${stats.rateLimited} unauthorized=${stats.unauthorized}`
    + ` graphql=${stats.graphql} parsed=${stats.parsed} accepted=${stats.accepted}`
    + ` rejected=${JSON.stringify(stats.rejected)}`,
  );
  if (!stats.accepted && stats.requests > 0) {
    if (stats.rateLimited > 0) args.warnings?.push("Instagram 登录态搜索当前被平台限流，已跳过本轮 Instagram 补充。");
    else if (stats.unauthorized > 0) args.warnings?.push("Instagram 登录态搜索未授权或会话失效，请刷新 Instagram Cookie。");
    else if (stats.ok > 0 && stats.parsed === 0) args.warnings?.push("Instagram 登录态搜索已请求成功，但本轮未解析到可用帖子。");
  }
  writeGlobalSentimentHotCandidatePool([...globalPoolCandidates.values()]);
  return sortSentimentHotCandidatePool(results, args.keywords, args.limit, args.searchMode);
}

async function fetchInstagramReaderSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  refresh?: boolean;
  excludeIds?: Set<string>;
  freshnessDays?: number;
  searchMode?: SentimentHotSearchMode;
  warnings?: string[];
}): Promise<SentimentHotCandidate[]> {
  const excluded = args.excludeIds || (args.refresh ? getSentimentHotRefreshExcludedIds(args.archiveId) : getSentimentHotExcludedIds(args.archiveId));
  const all: SentimentHotCandidate[] = [];
  const allKeys = new Set<string>();
  const globalPoolCandidates = new Map<string, SentimentHotCandidate>();
  let plannedRequests = 0;
  let successfulResponses = 0;
  let failedResponses = 0;
  let rateLimitedResponses = 0;
  let loginWallResponses = 0;
  let postLinkResponses = 0;
  const searches = await Promise.all(
    args.queries.map(async (query) => {
      const normalizedQuery = cleanText(query).replace(/^#/, "");
      // Chinese tag pages expose post links and engagement snippets. The
      // keyword-search page adds no useful public result here, while doubling
      // requests and causing the bounded live stage to time out. Keep it only
      // for non-Han terms, where it is the applicable public endpoint.
      const targets = hasHan(normalizedQuery)
        ? [`https://www.instagram.com/explore/tags/${encodeURIComponent(normalizedQuery)}/`]
        : [`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(normalizedQuery)}`];
      plannedRequests += targets.length;
      const texts: Array<{ query: string; targetUrl: string; text: string; rawHtml: string }> = [];
      for (const targetUrl of targets) {
        try {
          const response = await fetchWithSharedPublicCrawlerLimit(targetUrl, {
            headers: {
              "user-agent": "Mozilla/5.0",
              accept: "text/plain, text/markdown, */*",
              "cache-control": "max-age=300",
            },
          // A forced Reader refresh adds a cache-busting query parameter to
          // the Instagram public URL. Instagram can answer that artificial
          // URL with a login-wall document even when the canonical public tag
          // page is readable. Bypass only this app cache for an explicit
          // refresh, while preserving the canonical public URL.
          }, 8_000, args.refresh ? "bypass" : "swr");
          if (!response.ok) {
            failedResponses += 1;
            if (response.status === 429) rateLimitedResponses += 1;
            continue;
          }
          successfulResponses += 1;
          const text = await response.text();
          if (/Log into Instagram|登入 Instagram|登录 Instagram|Continue to Instagram/i.test(text)) {
            loginWallResponses += 1;
          }
          if (/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[\w-]+/i.test(text)) {
            postLinkResponses += 1;
          }
          texts.push({
            query,
            targetUrl,
            text,
            rawHtml: spiderRawHtmlByTargetUrl.get(new URL(targetUrl).toString()) || "",
          });
        } catch {
          failedResponses += 1;
          // Instagram reader is an opportunistic extra source.
        }
      }
      return texts;
    }),
  );
  for (const search of searches.flat()) {
    // Spider keeps the original HTML beside the Reader-compatible text. The
    // hydration nodes preserve the exact shortcode/caption/play-count mapping;
    // prefer them over broad Markdown windows, which can merge adjacent cards.
    const parsedById = new Map<string, SentimentHotCandidate>();
    for (const candidate of parseInstagramSpiderHydrationCandidates({
      html: search.rawHtml,
      query: search.query,
      keywords: args.keywords,
      includeUnmatched: true,
      limit: Math.max(50, args.limit * 5),
    })) parsedById.set(candidate.id, candidate);
    for (const candidate of parseInstagramReaderSearchMarkdownCandidates({
      text: search.text,
      query: search.query,
      keywords: args.keywords,
      includeUnmatched: true,
      sourceUrl: search.targetUrl,
      limit: Math.max(50, args.limit * 5),
    })) {
      if (!parsedById.has(candidate.id)) parsedById.set(candidate.id, candidate);
    }
    const parsed = [...parsedById.values()];
    for (const candidate of parsed) globalPoolCandidates.set(candidate.id, candidate);
    for (const candidate of parsed) {
      if (all.length >= args.limit) continue;
      if (excluded.has(candidate.id)) continue;
      if (!candidateTouchesCurrentKeywords(candidate, args.keywords)) continue;
      const normalized = args.searchMode && args.freshnessDays
        ? candidateMeetsDisplayQuality(candidate, args.keywords, args.searchMode, args.freshnessDays)
        : candidate;
      if (!normalized) continue;
      const dedupeKey = sentimentCandidateDedupeKey(normalized);
      if (all.some((item) => item.id === normalized.id) || allKeys.has(dedupeKey)) continue;
      allKeys.add(dedupeKey);
      all.push(normalized);
    }
  }
  console.info(
    `[sentiment_hot_instagram_reader] archiveId=${args.archiveId}`
    + ` requests=${plannedRequests} ok=${successfulResponses} failed=${failedResponses}`
    + ` rateLimited=${rateLimitedResponses} loginWalls=${loginWallResponses}`
    + ` postPayloads=${postLinkResponses} parsed=${all.length}`,
  );
  if (!all.length && plannedRequests > 0) {
    if (rateLimitedResponses > 0) args.warnings?.push("Instagram Reader 当前被上游限流，已跳过本轮 Instagram 公开源补充。");
    else if (loginWallResponses > 0) args.warnings?.push("Instagram Reader 当前返回登录墙，未读取到公开帖子。");
    else if (successfulResponses > 0 && !postLinkResponses) args.warnings?.push("Instagram Reader 已返回页面，但未发现可用帖子链接。");
  }
  writeGlobalSentimentHotCandidatePool([...globalPoolCandidates.values()]);
  return sortUsefulHotCandidates(all, args.limit);
}

function decodeMarkdownLinkText(value: string): string {
  return cleanText(
    value
      .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

function cleanThreadsReaderContent(value: string): string {
  const lines = String(value || "")
    .replace(/Sorry,\s*we.{0,8}re having trouble playing this video\.(?:\s*Learn more)?/gi, " ")
    .replace(/\bVideo\s+\d+\b/gi, " ")
    .split(/\r?\n/g)
    .map((line) => decodeMarkdownLinkText(line))
    .filter(Boolean)
    .filter((line) => !/^(?:Translate|翻譯|翻译)$/i.test(line))
    .filter((line) => !/^Sorry,\s*we.{0,8}re having trouble playing this video\.(?:\s*Learn more)?$/i.test(line))
    .filter((line) => !/^Video\s+\d+$/i.test(line))
    .filter((line) => !/^\d+(?:[.,]\d+)?\s*[Kk萬万]?$/.test(line))
    .filter((line) => !/^(?:讚|赞|留言|回覆|回复|轉發|转发|分享|喜歡|喜欢)\s*\d+(?:[.,]\d+)?\s*[Kk萬万]?$/i.test(line))
    .filter((line) => !/^Image\s+\d+/i.test(line));
  return cleanSentimentCandidateContent(lines.join(" "))
    .replace(/Sorry,\s*we.{0,8}re having trouble playing this video\.(?:\s*Learn more)?/gi, " ")
    .replace(/\bVideo\s+\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMetricNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = cleanText(value).replace(/,/g, "");
  if (!text) return undefined;
  const match = text.match(/(\d+(?:\.\d+)?)\s*([Kk萬万])?/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const unit = match[2] || "";
  const valueNumber = /[Kk]/.test(unit) ? base * 1000 : /[萬万]/.test(unit) ? base * 10000 : base;
  return Math.max(0, Math.round(valueNumber));
}

function parseMetricNumberLoose(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = cleanText(value).replace(/,/g, "");
  if (!text) return undefined;
  const match = text.match(/(\d+(?:\.\d+)?)\s*([KkMm\u842c\u4e07])?/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const unit = match[2] || "";
  const valueNumber = /[Kk]/.test(unit)
    ? base * 1000
    : /[Mm]/.test(unit)
      ? base * 1_000_000
      : /[\u842c\u4e07]/.test(unit)
        ? base * 10000
        : base;
  return Math.max(0, Math.round(valueNumber));
}

function assignThreadsProfileHotMetric(out: Partial<ThreadsProfileHotMetrics>, label: string, value: number | undefined) {
  if (typeof value !== "number") return;
  if (/followers?|\u7c89\u7d72|\u7c89\u4e1d/i.test(label)) out.followers = value;
  else if (/following|\u8ffd\u8e64\u4e2d|\u5173\u6ce8\u4e2d/i.test(label)) out.following = value;
}

function parseThreadsProfileHotMetricsText(text: string): Partial<ThreadsProfileHotMetrics> {
  const lines = String(text || "")
    .split(/\r?\n+/g)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 250);
  const out: Partial<ThreadsProfileHotMetrics> = {};
  const joined = lines.join("\n");
  const labels = "followers?|following|\\u7c89\\u7d72|\\u7c89\\u4e1d|\\u8ffd\\u8e64\\u4e2d|\\u5173\\u6ce8\\u4e2d";
  const combined = new RegExp(`(\\d+(?:[.,]\\d+)?\\s*(?:[KkMm\\u842c\\u4e07])?)\\s*(${labels})`, "gi");
  for (const match of joined.matchAll(combined)) {
    assignThreadsProfileHotMetric(out, match[2] || "", parseMetricNumberLoose(match[1]));
  }
  for (const match of joined.matchAll(new RegExp(`(\\d+(?:[.,]\\d+)?\\s*(?:[KkMm\\u842c\\u4e07])?)\\s*(?:\\u4f4d)?\\s*(\\u7c89\\u7d72|\\u7c89\\u4e1d|followers?)`, "gi"))) {
    assignThreadsProfileHotMetric(out, match[2] || "", parseMetricNumberLoose(match[1]));
  }
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] || "";
    const next = lines[index + 1] || "";
    const prev = lines[index - 1] || "";
    const currentIsLabel = new RegExp(`^(${labels})$`, "i").test(current) || new RegExp(labels, "i").test(current);
    const nextIsLabel = new RegExp(`^(${labels})$`, "i").test(next) || new RegExp(labels, "i").test(next);
    if (currentIsLabel) assignThreadsProfileHotMetric(out, current, parseMetricNumberLoose(current) ?? parseMetricNumberLoose(next) ?? parseMetricNumberLoose(prev));
    else if (nextIsLabel) assignThreadsProfileHotMetric(out, next, parseMetricNumberLoose(current));
  }
  const readMetricRuns = (patterns: RegExp[], options?: { skip?: (matchText: string) => boolean }) => {
    const values: number[] = [];
    for (const pattern of patterns) {
      for (const match of joined.matchAll(pattern)) {
        if (options?.skip?.(match[0] || "")) continue;
        const value = parseMetricNumberLoose(match[1]);
        if (typeof value === "number") values.push(value);
      }
    }
    return values;
  };
  const uniqueMetricValues = (values: number[]) => [...new Set(values)];
  const metricNumber = "(\\d+(?:[.,]\\d+)?\\s*(?:[KkMm\\u842c\\u4e07])?)";
  const likeValues = readMetricRuns([
    new RegExp(`(?:讚|赞|likes?)\\s*${metricNumber}`, "gi"),
  ]);
  const commentValues = readMetricRuns([
    new RegExp(`(?:留言|評論|评论|comments?)\\s*${metricNumber}`, "gi"),
  ]);
  const shareValues = readMetricRuns([
    new RegExp(`(?:分享|轉發|转发|shares?|reposts?)\\s*${metricNumber}`, "gi"),
  ]);
  const recentViewValues = uniqueMetricValues(readMetricRuns([
    new RegExp(`${metricNumber}\\s*(?:次)?\\s*(?:最近瀏覽次數|最近浏览次数)`, "gi"),
  ]));
  const viewValues = readMetricRuns([
    new RegExp(`(?:瀏覽|浏览|觀看|观看|views?|plays?|impressions?)\\s*${metricNumber}`, "gi"),
    new RegExp(`${metricNumber}\\s*(?:次)?\\s*(?:最近瀏覽次數|最近浏览次数|瀏覽|浏览|觀看|观看|views?|plays?|impressions?)`, "gi"),
  ], { skip: (matchText) => /最近瀏覽次數|最近浏览次数/i.test(matchText) });
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const scannedPosts = Math.max(likeValues.length, commentValues.length, shareValues.length, viewValues.length);
  if (scannedPosts > 0) out.scannedPosts = scannedPosts;
  const likes = sum(likeValues);
  const comments = sum(commentValues);
  const shares = sum(shareValues);
  const views = sum(viewValues);
  if (recentViewValues.length) out.recentViews = Math.max(...recentViewValues);
  if (likes > 0) out.likes = likes;
  if (comments > 0) out.comments = comments;
  if (shares > 0) out.shares = shares;
  if (views > 0) out.views = views;
  return out;
}

function threadsProfileHotMetricsHasValue(metrics: Partial<ThreadsProfileHotMetrics>) {
  return ["followers", "following", "recentViews", "scannedPosts", "likes", "comments", "shares", "views"].some((key) => typeof (metrics as any)[key] === "number");
}

export function analyzeThreadsProfileVisibleSignals(args: {
  username: string;
  bodyText: string;
  buttonText: string[];
  links: string[];
}) {
  const text = [args.bodyText, ...(args.buttonText || [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");
  const parsed = parseThreadsProfileHotMetricsText(text);
  const postUrls = extractUniqueThreadsPostUrlsFromProfileLinks(args.links || [], args.username);
  return {
    text,
    rawText: text,
    parsed,
    postUrls,
    hasUsableProfileSignals: threadsProfileHotMetricsHasValue(parsed) || postUrls.length > 0,
  };
}

export function shouldTreatThreadsProfileAsLoginWall(args: {
  username: string;
  bodyText: string;
  buttonText: string[];
  links: string[];
}) {
  const visible = analyzeThreadsProfileVisibleSignals(args);
  return detectThreadsProfileLoginWall(visible.text) && !visible.hasUsableProfileSignals;
}

function hasThreadsProfileLoginSessionCookie(cookies: any[]) {
  return hasValidThreadsSessionCookie(cookies);
}

function buildThreadsProfileUrl(username: string) {
  return `https://www.threads.com/@${encodeURIComponent(username)}`;
}

function detectThreadsProfileLoginWall(text: string) {
  const rawText = String(text || "");
  if (/(?:編輯個人檔案|编辑个人档案|編輯主頁|编辑主页|洞察報告|成效分析)/i.test(rawText)) return false;
  return /login|log in|sign in|accounts\/login|登入以查看更多|使用 Instagram 帳號繼續|使用 Instagram 账号继续|登入 Instagram|登录 Instagram/i.test(rawText);
}

function buildThreadsProfileIncompleteMetrics(username: string, refreshedAt: string, scope: ThreadsProfileHotMetrics["scope"], rawText?: string): ThreadsProfileHotMetrics {
  return {
    platform: "threads",
    username,
    refreshedAt,
    method: "failed",
    complete: false,
    scope,
    rawText: rawText ? rawText.slice(0, 4000) : undefined,
    error: "Threads browser login is not valid for full account aggregation. Refresh Threads sentiment cookies with a logged-in sessionid before retrying.",
  };
}

type ThreadsGraphqlProfilePostAggregate = {
  pk: string;
  code: string;
  sourceUrl: string;
  content?: string;
  publishedAt?: string;
  likeCount: number;
  commentCount: number;
  repostCount: number;
  shareCount: number;
  viewCount?: number;
};

function normalizeThreadsProfileUsername(value: unknown): string {
  return String(value || "").replace(/^@+/, "").trim().toLowerCase();
}

function resolveThreadsGraphqlPostOwnerUsername(post: any): string {
  const candidates = [
    post?.user?.username,
    post?.owner?.username,
    post?.caption?.user?.username,
    post?.caption?.owner?.username,
    post?.text_post_app_info?.user?.username,
    post?.text_post_app_info?.owner?.username,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeThreadsProfileUsername(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function isThreadsGraphqlProfileOwnedPost(username: string, post: any): boolean {
  const target = normalizeThreadsProfileUsername(username);
  const owner = resolveThreadsGraphqlPostOwnerUsername(post);
  return !target || !owner || owner === target;
}

function isThreadsGraphqlProfileRepostOrQuote(post: any): boolean {
  if (!post || typeof post !== "object") return false;
  const info = post.text_post_app_info && typeof post.text_post_app_info === "object"
    ? post.text_post_app_info
    : {};
  if (
    post.is_repost === true
    || post.is_reshare === true
    || post.is_quote === true
    || info.is_repost === true
    || info.is_reshare === true
    || info.is_quote === true
  ) return true;
  const stack = [post, info];
  const visited = new Set<any>();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:repost|reshare|quote|quoted)_?(?:info|post|media|thread|item|content|share)$/i.test(key)) {
        if (child && (typeof child !== "object" || Object.keys(child as Record<string, unknown>).length > 0)) return true;
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

function isSuspiciousThreadsProfileMetricMix(post: Partial<ThreadsGraphqlProfilePostAggregate>): boolean {
  if (typeof post.viewCount !== "number" || post.viewCount <= 0) return false;
  const strongestInteraction = Math.max(
    Number(post.likeCount || 0),
    Number(post.commentCount || 0),
    Number(post.repostCount || 0),
    Number(post.shareCount || 0),
  );
  return strongestInteraction >= 1000 && strongestInteraction > post.viewCount * 20;
}

type ThreadsGraphqlProfilePageResult = {
  posts: ThreadsGraphqlProfilePostAggregate[];
  endCursor?: string;
  hasNextPage: boolean;
  pageInfoResolved: boolean;
};

type ThreadsGraphqlRequestTemplate = {
  params: Record<string, string>;
  variables: Record<string, any>;
};

function buildThreadsGraphqlProfileSourceUrl(username: string, post: any): string {
  const normalizedUsername = String(username || "").replace(/^@+/, "").trim();
  const canonicalUrl = cleanText(post?.canonical_url || post?.canonicalUrl);
  if (/^https?:\/\/(?:www\.)?threads\.(?:net|com)\//i.test(canonicalUrl)) {
    return canonicalUrl.replace(/^https:\/\/www\.threads\.net\//i, "https://www.threads.com/");
  }
  const code = cleanText(post?.code);
  if (!normalizedUsername || !code) return "";
  return `https://www.threads.com/@${encodeURIComponent(normalizedUsername)}/post/${encodeURIComponent(code)}`;
}

function normalizeThreadsPostUrlKey(value: unknown): string {
  return String(value || "")
    .replace(/^https:\/\/www\.threads\.net\//i, "https://www.threads.com/")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function resolveThreadsProfilePostMergeKey(post: Partial<ThreadsGraphqlProfilePostAggregate>) {
  return cleanText(post.code)
    || normalizeThreadsPostUrlKey(post.sourceUrl)
    || cleanText(post.pk);
}

function threadsGraphqlProfileMediaData(payload: any): any {
  return payload?.data?.mediaData
    || payload?.data?.xdt_api__v1__text_feed__user_id__profile__connection
    || payload?.data?.xdt_api__v1__text_feed__username__profile__connection
    || null;
}

export function parseThreadsGraphqlProfilePagePayload(args: {
  username: string;
  payload: any;
}): ThreadsGraphqlProfilePageResult {
  const mediaData = threadsGraphqlProfileMediaData(args.payload);
  const edges = Array.isArray(mediaData?.edges) ? mediaData.edges : [];
  const posts: ThreadsGraphqlProfilePostAggregate[] = [];
  for (const edge of edges) {
    const post = edge?.node?.thread_items?.[0]?.post;
    if (!isThreadsGraphqlProfileOwnedPost(args.username, post)) continue;
    if (isThreadsGraphqlProfileRepostOrQuote(post)) continue;
    const pk = cleanText(post?.pk);
    const sourceUrl = buildThreadsGraphqlProfileSourceUrl(args.username, post);
    const content = cleanText(post?.caption?.text || post?.text_post_app_info?.share_text || post?.text_post_app_info?.text || "");
    const publishedAt = normalizeThreadsTimestamp(
      post?.taken_at
        ?? post?.taken_at_timestamp
        ?? post?.created_at
        ?? post?.caption?.created_at,
    );
    const rawViewCount = [
      post?.text_post_app_info?.view_count,
      post?.text_post_app_info?.viewCount,
      post?.view_count,
      post?.viewCount,
      post?.play_count,
      post?.playCount,
    ].find((value) => value !== null && value !== undefined && value !== "");
    if (!pk || !sourceUrl) continue;
    posts.push({
      pk,
      code: cleanText(post?.code),
      sourceUrl,
      ...(content ? { content } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      likeCount: Math.max(0, Number(post?.like_count) || 0),
      commentCount: Math.max(0, Number(post?.text_post_app_info?.direct_reply_count) || 0),
      repostCount: Math.max(0, Number(post?.text_post_app_info?.repost_count) || 0),
      shareCount: Math.max(0, Number(post?.text_post_app_info?.reshare_count) || 0),
      ...(rawViewCount === undefined ? {} : { viewCount: Math.max(0, Number(rawViewCount) || 0) }),
    });
  }
  return {
    posts,
    endCursor: cleanText(mediaData?.page_info?.end_cursor),
    hasNextPage: mediaData?.page_info?.has_next_page === true,
    pageInfoResolved: typeof mediaData?.page_info?.has_next_page === "boolean",
  };
}

function parseThreadsGraphqlRequestTemplate(postData: string): ThreadsGraphqlRequestTemplate | null {
  const params = new URLSearchParams(String(postData || ""));
  const rawVariables = params.get("variables");
  if (!rawVariables) return null;
  const variables = safeJson(rawVariables);
  if (!variables || typeof variables !== "object") return null;
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  delete out.variables;
  return {
    params: out,
    variables,
  };
}

async function requestThreadsGraphqlProfilePage(args: {
  page: any;
  template: ThreadsGraphqlRequestTemplate;
  after: string;
}): Promise<any> {
  const params = new URLSearchParams(args.template.params);
  params.set("variables", JSON.stringify({
    ...args.template.variables,
    after: args.after,
  }));
  const timeoutMs = 15_000;
  const result = await threadsGraphqlRateLimiter.run(
    THREADS_GRAPHQL_UPSTREAM_KEY,
    async ({ signal }) => {
      if (signal.aborted) throw signal.reason;
      const response = await args.page.evaluate(async ({ body, timeoutMs }: { body: string; timeoutMs: number }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const result = await fetch("https://www.threads.com/graphql/query", {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            body,
            signal: controller.signal,
          });
          return {
            ok: result.ok,
            status: result.status,
            retryAfter: result.headers.get("retry-after") || "",
            text: result.ok ? await result.text() : "",
          };
        } finally {
          clearTimeout(timeoutId);
        }
      }, { body: params.toString(), timeoutMs });
      return {
        ...response,
        headers: { "retry-after": response.retryAfter },
      };
    },
    { timeoutMs },
  );
  return result.ok ? safeJson(result.text) : null;
}

async function collectThreadsGraphqlProfilePosts(args: {
  page: any;
  username: string;
  initialPayload: any;
  initialTemplate: ThreadsGraphqlRequestTemplate;
}): Promise<{ posts: ThreadsGraphqlProfilePostAggregate[]; reachedEnd: boolean }> {
  const byPk = new Map<string, ThreadsGraphqlProfilePostAggregate>();
  let current = parseThreadsGraphqlProfilePagePayload({
    username: args.username,
    payload: args.initialPayload,
  });
  for (const post of current.posts) byPk.set(post.pk, post);
  let cursor = current.endCursor || "";
  let hasNextPage = current.hasNextPage;
  let pageInfoResolved = current.pageInfoResolved;
  let pages = 0;
  while (hasNextPage && cursor && pages < 120) {
    pages += 1;
    const payload = await requestThreadsGraphqlProfilePage({
      page: args.page,
      template: args.initialTemplate,
      after: cursor,
    }).catch(() => null);
    if (!payload) return { posts: [...byPk.values()], reachedEnd: false };
    current = parseThreadsGraphqlProfilePagePayload({
      username: args.username,
      payload,
    });
    if (current.posts.length === 0 && !current.endCursor) {
      return { posts: [...byPk.values()], reachedEnd: pages >= 2 || byPk.size >= 20 };
    }
    const beforeSize = byPk.size;
    for (const post of current.posts) byPk.set(post.pk, post);
    if (byPk.size === beforeSize && current.endCursor === cursor) {
      return { posts: [...byPk.values()], reachedEnd: current.pageInfoResolved && current.hasNextPage !== true };
    }
    cursor = current.endCursor || "";
    hasNextPage = current.hasNextPage;
    pageInfoResolved = current.pageInfoResolved;
  }
  return { posts: [...byPk.values()], reachedEnd: pageInfoResolved && hasNextPage !== true };
}

async function scrollThreadsProfileUntilGraphqlEnd(args: {
  page: any;
  capturedGraphqlPages: Map<string, { payload: any; template: ThreadsGraphqlRequestTemplate }>;
  username: string;
  maxScrolls?: number;
  afterScroll?: () => Promise<void>;
}): Promise<boolean> {
  let stagnantRounds = 0;
  let bottomRounds = 0;
  let lastGraphqlCount = args.capturedGraphqlPages.size;
  let lastVisibleKeyCount = 0;
  let lastScrollY = -1;
  const seenVisiblePostKeys = new Set<string>();
  for (let scroll = 0; scroll < (args.maxScrolls || 160); scroll += 1) {
    const reachedEnd = [...args.capturedGraphqlPages.values()].some(({ payload }) => {
      const pageResult = parseThreadsGraphqlProfilePagePayload({ username: args.username, payload });
      return pageResult.pageInfoResolved && pageResult.hasNextPage !== true;
    });
    if (reachedEnd) return true;
    const visibleKeys = await args.page.evaluate((targetUsername: string) => {
      const normalizedUsername = String(targetUsername || "").replace(/^@+/, "").trim().toLowerCase();
      return Array.from(document.querySelectorAll("a[href*='/post/']"))
        .map((anchor: any) => String(anchor.href || anchor.getAttribute?.("href") || ""))
        .filter((href) => href.toLowerCase().includes("/@" + normalizedUsername + "/post/"))
        .map((href) => href.replace(/[?#].*$/, "").replace(/\/+$/, ""));
    }, args.username).catch(() => []);
    for (const key of visibleKeys || []) {
      if (key) seenVisiblePostKeys.add(key);
    }
    await args.afterScroll?.().catch(() => undefined);
    await args.page.mouse.wheel(0, 1800).catch(() => undefined);
    await args.page.waitForTimeout(1200);
    const nextGraphqlCount = args.capturedGraphqlPages.size;
    const scrollState = await args.page.evaluate(() => {
      const scrollY = Math.round(window.scrollY || document.documentElement?.scrollTop || 0);
      const viewportHeight = Math.round(window.innerHeight || document.documentElement?.clientHeight || 0);
      const pageHeight = Math.round(Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0));
      return { scrollY, atBottom: scrollY + viewportHeight >= pageHeight - 80 };
    }).catch(() => ({ scrollY: -1, atBottom: false }));
    const scrollY = scrollState.scrollY;
    bottomRounds = scrollState.atBottom ? bottomRounds + 1 : 0;
    if (nextGraphqlCount === lastGraphqlCount
      && seenVisiblePostKeys.size <= lastVisibleKeyCount
      && Math.abs(scrollY - lastScrollY) < 40) {
      stagnantRounds += 1;
      if (bottomRounds >= 3) return true;
      if (stagnantRounds >= 12) return false;
    } else {
      stagnantRounds = 0;
      lastGraphqlCount = nextGraphqlCount;
      lastVisibleKeyCount = seenVisiblePostKeys.size;
      lastScrollY = scrollY;
    }
  }
  return false;
}

function normalizeThreadsVisibleDate(value: unknown): string | undefined {
  const match = String(value || "").match(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function normalizeThreadsRelativeTime(value: unknown, now = Date.now()): string | undefined {
  const text = String(value || "").replace(/\s+/g, "").trim();
  const match = text.match(/^(\d+(?:[.,]\d+)?)(秒|分鐘|分钟|分|小時|小时|時|时|天|日|週|周|月|年|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|mos|y|yr|yrs)$/i);
  if (!match) return undefined;
  const amount = Number(String(match[1]).replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = String(match[2] || "").toLowerCase();
  const millis =
    /^(秒|s|sec|secs)$/.test(unit) ? amount * 1000 :
    /^(分鐘|分钟|分|m|min|mins)$/.test(unit) ? amount * 60_000 :
    /^(小時|小时|時|时|h|hr|hrs)$/.test(unit) ? amount * 3_600_000 :
    /^(天|日|d|day|days)$/.test(unit) ? amount * 86_400_000 :
    /^(週|周|w|wk|wks)$/.test(unit) ? amount * 7 * 86_400_000 :
    /^(月|mo|mos)$/.test(unit) ? amount * 30 * 86_400_000 :
    /^(年|y|yr|yrs)$/.test(unit) ? amount * 365 * 86_400_000 :
    0;
  if (!millis) return undefined;
  const date = new Date(now - millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeThreadsVisiblePublishedAt(value: unknown): string | undefined {
  return normalizeThreadsVisibleDate(value) || normalizeThreadsRelativeTime(value);
}

function parseThreadsVisibleMetric(actionTexts: string[], labelPattern: RegExp): number | undefined {
  for (const actionText of actionTexts || []) {
    const compact = String(actionText || "").replace(/\s+/g, "").trim();
    if (!labelPattern.test(compact)) continue;
    const count = parseMetricNumberLoose(compact.replace(labelPattern, ""));
    return typeof count === "number" ? count : 0;
  }
  return undefined;
}

async function extractThreadsVisibleProfilePosts(args: {
  page: any;
  username: string;
}): Promise<ThreadsGraphqlProfilePostAggregate[]> {
  const username = String(args.username || "").replace(/^@+/, "").trim();
  if (!username) return [];
  const debugVisible = process.env.THREADS_PROFILE_DEBUG_VISIBLE === "1";
  let visibleExtractor: Function;
  try {
    visibleExtractor = new Function("payload", String.raw`
    const targetUsername = payload.targetUsername;
    const debug = payload.debug;
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const anchors = Array.from(document.querySelectorAll("a[href*='/post/']"));
    const out = [];
    const debugRows = [];
    const seen = new Set();
    for (const anchor of anchors) {
      const href = String(anchor.href || anchor.getAttribute("href") || "");
      const matchesProfile = href.toLowerCase().includes("/@" + String(targetUsername || "").toLowerCase() + "/post/");
      const dateText = normalize(anchor.textContent || "");
      const matchesDate = /20\d{2}[\/-]\d{1,2}[\/-]\d{1,2}/.test(dateText);
      const matchesRelativeTime = /^\d+(?:[.,]\d+)?(?:秒|分鐘|分钟|分|小時|小时|時|时|天|日|週|周|月|年|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|mos|y|yr|yrs)$/i.test(dateText.replace(/\s+/g, ""));
      const looksLikePostLink = /\/post\/[^/?#]+(?:[?#].*)?$/i.test(href);
      if (debug && debugRows.length < 8) debugRows.push({ href, dateText, matchesProfile, matchesDate, matchesRelativeTime, looksLikePostLink });
      if (!matchesProfile) continue;
      if (!looksLikePostLink) continue;
      if (!matchesDate && !matchesRelativeTime) continue;
      let node = anchor;
      let best = null;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const text = normalize(node.innerText || node.textContent || "");
        if (text.includes(targetUsername) && text.includes(dateText) && text.length > dateText.length + 8) best = node;
        node = node.parentElement;
      }
      const container = best || anchor.parentElement;
      const fullText = String(container?.innerText || container?.textContent || "").trim();
      const actionTexts = Array.from(container?.querySelectorAll("[role=button],button") || [])
        .map((item) => normalize(item.textContent || ""))
        .filter(Boolean);
      if (!fullText) continue;
      const key = href.replace(/[?#].*$/, "").replace(/\/+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sourceUrl: key, dateText, text: fullText, actionTexts });
    }
    return { out, debugRows, anchorCount: anchors.length };
  `);
  } catch (error: any) {
    if (debugVisible) {
      console.log("[threads-profile-visible-anchors]", JSON.stringify({ username, anchorCount: -1, samples: [], error: `construct:${String(error?.message || error)}` }));
    }
    return [];
  }
  let rows: any;
  try {
    rows = await args.page.evaluate(visibleExtractor as any, {
      targetUsername: username,
      debug: debugVisible,
    });
  } catch (error: any) {
    rows = { out: [], debugRows: [], anchorCount: -1, error: String(error?.message || error) };
  }
  if (debugVisible) {
    console.log("[threads-profile-visible-anchors]", JSON.stringify({ username, anchorCount: rows.anchorCount, samples: rows.debugRows, error: (rows as any).error }));
  }
  const posts: ThreadsGraphqlProfilePostAggregate[] = [];
  for (const row of rows.out || []) {
    const sourceUrl = normalizeThreadsPostUrlKey(row.sourceUrl);
    const code = cleanText(sourceUrl.match(/\/post\/([^/?#]+)/i)?.[1]);
    if (!sourceUrl || !code) continue;
    const lines = String(row.text || "")
      .split(/\n+/)
      .map((line) => cleanText(line))
      .filter(Boolean);
    const contentLines = lines.filter((line) => {
      if (line === username || line === row.dateText) return false;
      if (/^(串文|回覆|影音內容|轉發|追蹤|發送訊息|更多|翻譯|Instagram)$/i.test(line)) return false;
      if (/^(讚|回覆|回复|留言|轉發|分享)\s*\d*$/i.test(line.replace(/\s+/g, ""))) return false;
      if (/^\d+(?:[,.]\d+)?\s*(?:K|M|萬|万)?$/.test(line)) return false;
      if (/^20\d{2}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(line)) return false;
      return true;
    });
    const content = cleanText(contentLines.join(" "));
    posts.push({
      pk: `visible:${code}`,
      code,
      sourceUrl,
      ...(content ? { content } : {}),
      ...(normalizeThreadsVisiblePublishedAt(row.dateText) ? { publishedAt: normalizeThreadsVisiblePublishedAt(row.dateText) } : {}),
      likeCount: parseThreadsVisibleMetric(row.actionTexts, /^(?:Like|Likes|讚|赞|喜歡|喜欢)/i) || 0,
      commentCount: parseThreadsVisibleMetric(row.actionTexts, /^(?:Comment|Comments|Reply|Replies|留言|回覆|回复|評論|评论)/i) || 0,
      repostCount: parseThreadsVisibleMetric(row.actionTexts, /^(?:Repost|Reposts|轉發|转发)/i) || 0,
      shareCount: parseThreadsVisibleMetric(row.actionTexts, /^(?:Share|Shares|分享|傳送|发送|傳送給|发送给)/i) || 0,
    });
  }
  return posts;
}

export function parseThreadsPostViewCountFromText(text: string): number | undefined {
  return parseMetricNumberLoose(
    String(text || "").match(/(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*(?:次瀏覽|次浏览|瀏覽|浏览|views?)/i)?.[1]
      || String(text || "").match(/Thread\s+(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s+views/i)?.[1]
      || String(text || "").match(/(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*views/i)?.[1],
  );
}

async function readThreadsViewCountFromLoadedPostPage(page: any): Promise<number | undefined> {
  await page.waitForFunction(() => {
    const text = String(document.body?.innerText || "");
    return /(\d+(?:[.,]\d+)?\s*(?:K|M|萬|万)?)\s*(次瀏覽|次浏览|瀏覽|浏览|views?)/i.test(text);
  }, undefined, { timeout: 8_000 }).catch(() => null);
  const text = await page.locator("body").innerText({ timeout: 6_000 }).catch(() => "");
  return parseThreadsPostViewCountFromText(text);
}

async function readThreadsPublicViewCountFallback(page: any, sourceUrl: string): Promise<number | undefined> {
  const browser = page.context?.()?.browser?.();
  if (!browser) return undefined;
  const context = await browser.newContext({
    viewport: { width: 900, height: 1400 },
    locale: "zh-TW",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const publicPage = await context.newPage();
  try {
    await publicPage.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    }).catch(() => null);
    return await readThreadsViewCountFromLoadedPostPage(publicPage);
  } finally {
    await context.close().catch(() => null);
  }
}

async function readThreadsViewCountFromPostPage(args: {
  page: any;
  sourceUrl: string;
}): Promise<number | undefined> {
  await args.page.goto(args.sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: 25_000,
  }).catch(() => null);
  const viewCount = await readThreadsViewCountFromLoadedPostPage(args.page);
  return typeof viewCount === "number"
    ? viewCount
    : readThreadsPublicViewCountFallback(args.page, args.sourceUrl);
}

async function collectThreadsViewCountsFromPostPages(args: {
  context: any;
  posts: ThreadsGraphqlProfilePostAggregate[];
}): Promise<{ totalViews: number; resolvedPosts: number; viewsByUrl: Record<string, number> }> {
  if (!args.posts.length) return { totalViews: 0, resolvedPosts: 0, viewsByUrl: {} };
  const workers = Math.min(boundedBrowserPageConcurrency(args.posts.length), args.posts.length);
  let cursor = 0;
  let totalViews = 0;
  let resolvedPosts = 0;
  const viewsByUrl: Record<string, number> = {};
  await Promise.all(Array.from({ length: workers }, async () => {
    const page = await args.context.newPage();
    try {
      while (cursor < args.posts.length) {
        const post = args.posts[cursor++];
        const viewCount = await readThreadsViewCountFromPostPage({
          page,
          sourceUrl: post.sourceUrl,
        }).catch(() => undefined);
        if (typeof viewCount === "number") {
          viewsByUrl[post.sourceUrl] = viewCount;
          totalViews += viewCount;
          resolvedPosts += 1;
        }
      }
    } finally {
      await page.close().catch(() => null);
    }
  }));
  return { totalViews, resolvedPosts, viewsByUrl };
}

async function buildThreadsProfileAggregateMetrics(args: {
  username: string;
  text: string;
  links: string[];
}): Promise<Partial<ThreadsProfileHotMetrics>> {
  const postUrls = extractUniqueThreadsPostUrlsFromProfileLinks(args.links || [], args.username);
  const out: Partial<ThreadsProfileHotMetrics> = {};
  if (postUrls.length > 0) {
    out.scannedPosts = postUrls.length;
    out.posts = postUrls.length;
  }
  const detailResults = await Promise.all(
    postUrls.slice(0, 80).map(async (sourceUrl) => ({
      sourceUrl,
      detail: await fetchThreadsDetailData(sourceUrl).catch(() => ({ engagement: {}, media: [] })),
    })),
  );
  let views = 0;
  const postMetrics: ThreadsProfilePostHotMetrics[] = [];
  for (const result of detailResults) {
    const engagement = result.detail.engagement || {};
    const viewCount = typeof engagement.viewCount === "number" ? engagement.viewCount : undefined;
    if (typeof viewCount === "number") views += viewCount;
    postMetrics.push({
      sourceUrl: result.sourceUrl,
      likeCount: typeof engagement.likeCount === "number" ? engagement.likeCount : undefined,
      commentCount: typeof engagement.commentCount === "number" ? engagement.commentCount : undefined,
      viewCount,
    });
  }
  if (views > 0) out.views = views;
  if (postMetrics.length > 0) out.postMetrics = postMetrics;
  return out;
}

async function buildThreadsProfileAggregateMetricsFromBrowserPage(args: {
  page: any;
  username: string;
  links: string[];
}): Promise<Partial<ThreadsProfileHotMetrics>> {
  const postUrls = extractUniqueThreadsPostUrlsFromProfileLinks(args.links || [], args.username).slice(0, 120);
  const out: Partial<ThreadsProfileHotMetrics> = {};
  if (postUrls.length > 0) {
    out.scannedPosts = postUrls.length;
    out.posts = postUrls.length;
  }
  let likes = 0;
  let comments = 0;
  let reposts = 0;
  let shares = 0;
  let views = 0;
  const postMetrics: ThreadsProfilePostHotMetrics[] = [];
  for (const sourceUrl of postUrls) {
    await args.page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    }).catch(() => null);
    await args.page.waitForTimeout(2200);
    const detailText = await args.page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
    const actionTexts = await args.page.$$eval("[role=button],button,a", (items: any[]) => items
      .map((item: any) => (item.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 120)).catch(() => []);
    const detail = parseThreadsBrowserPostDetailMetrics({ text: detailText, actionTexts });
    const engagement = detail?.engagement || {};
    const metrics = detail?.metrics || {};
    likes += typeof engagement.likeCount === "number" ? engagement.likeCount : 0;
    comments += typeof engagement.commentCount === "number" ? engagement.commentCount : 0;
    reposts += typeof metrics.repost_count === "number" ? metrics.repost_count : 0;
    shares += typeof metrics.send_count === "number" ? metrics.send_count : 0;
    views += typeof engagement.viewCount === "number" ? engagement.viewCount : 0;
    postMetrics.push({
      sourceUrl,
      likeCount: typeof engagement.likeCount === "number" ? engagement.likeCount : undefined,
      commentCount: typeof engagement.commentCount === "number" ? engagement.commentCount : undefined,
      repostCount: typeof metrics.repost_count === "number" ? metrics.repost_count : undefined,
      shareCount: typeof metrics.send_count === "number" ? metrics.send_count : undefined,
      viewCount: typeof engagement.viewCount === "number" ? engagement.viewCount : undefined,
    });
  }
  if (postUrls.length > 0) {
    out.likes = likes;
    out.comments = comments;
    out.reposts = reposts;
    out.shares = shares;
  }
  if (views > 0) out.views = views;
  if (postMetrics.length > 0) out.postMetrics = postMetrics;
  return out;
}

type SessionHttpResult = {
  ok: boolean;
  status: number;
  url: string;
  text: string;
};

function platformProxyUrl(platform: "threads" | "instagram"): string {
  return cleanText(
    platform === "threads"
      ? process.env.PERSONA_DASHBOARD_THREADS_PROXY_URL
      : process.env.PERSONA_DASHBOARD_INSTAGRAM_PROXY_URL,
  );
}

export function buildPlatformCookieHeader(cookies: any[], targetUrl: string): string {
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie: any) => {
      const name = cleanText(cookie?.name);
      const value = cleanText(cookie?.value);
      const domain = cleanText(cookie?.domain).replace(/^\./, "").toLowerCase();
      if (!name || !value || !domain) return false;
      return hostname === domain || hostname.endsWith(`.${domain}`);
    })
    .map((cookie: any) => `${String(cookie.name).trim()}=${String(cookie.value).trim()}`)
    .join("; ");
}

async function requestSessionHttpText(args: {
  url: string;
  cookies: any[];
  headers?: Record<string, string>;
  proxyUrl?: string;
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: string;
}): Promise<SessionHttpResult> {
  const proxyUrl = cleanText(args.proxyUrl);
  if (proxyUrl && !/^https?:\/\//i.test(proxyUrl)) {
    throw new Error("当前账号代理不是 HTTP/HTTPS 类型，已转入浏览器兼容链路。");
  }
  const cookie = buildPlatformCookieHeader(args.cookies, args.url);
  const method = args.method === "POST" ? "POST" : "GET";
  const headers = {
    accept: "*/*",
    "accept-language": "zh-TW,zh;q=0.9,en;q=0.6",
    ...(cookie ? { cookie } : {}),
    ...(args.headers || {}),
  };
  const run = async (dispatcher?: any): Promise<SessionHttpResult> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1_000, args.timeoutMs || 20_000));
    try {
      const response = await fetch(args.url, {
        method,
        redirect: "follow",
        maxRedirections: 4,
        signal: controller.signal,
        headers,
        ...(method === "POST" && args.body != null ? { body: args.body } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      } as any);
      return {
        ok: response.ok,
        status: response.status,
        url: response.url || args.url,
        text: await response.text(),
      };
    } finally {
      clearTimeout(timeoutId);
      await dispatcher?.close().catch(() => undefined);
    }
  };
  try {
    return await run(undefined);
  } catch (error) {
    if (!proxyUrl) throw error;
    const text = [
      error instanceof Error ? error.message : String(error || ""),
      error instanceof Error && error.cause ? String((error.cause as any)?.code || (error.cause as any)?.message || error.cause) : "",
    ].join(" ");
    if (!/fetch failed|redirect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|timeout|abort|UND_ERR|Invalid URL|proxy/i.test(text)) {
      throw error;
    }
    const dispatcher = new ProxyAgent(proxyUrl);
    return await run(dispatcher);
  }
}

function walkJsonObjects(value: any, visit: (node: any) => void, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 40) return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJsonObjects(item, visit, depth + 1);
    return;
  }
  for (const child of Object.values(value)) walkJsonObjects(child, visit, depth + 1);
}

function firstFiniteMetricNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
    if (typeof value === "string" && value.trim()) {
      const parsed = parseMetricNumberLoose(value);
      if (typeof parsed === "number") return parsed;
    }
  }
  return undefined;
}

function mergeThreadsProfileIdentityMetrics(
  target: Partial<ThreadsProfileHotMetrics>,
  source: Partial<ThreadsProfileHotMetrics>,
): void {
  if (typeof source.followers === "number") target.followers = source.followers;
  if (typeof source.following === "number") target.following = source.following;
  if (typeof source.recentViews === "number") target.recentViews = source.recentViews;
}

function threadsProfileIdentityMetricsFromUserNode(node: any, username: string): Partial<ThreadsProfileHotMetrics> {
  const nodeUsername = cleanText(node?.username || node?.unique_id).replace(/^@+/, "").toLowerCase();
  if (!username || nodeUsername !== username) return {};
  const profileInfo = node?.text_post_app_profile_info && typeof node.text_post_app_profile_info === "object"
    ? node.text_post_app_profile_info
    : {};
  const insightInfo = node?.text_post_app_insights && typeof node.text_post_app_insights === "object"
    ? node.text_post_app_insights
    : {};
  const out: Partial<ThreadsProfileHotMetrics> = {};
  const followers = firstFiniteMetricNumber(
    node.follower_count,
    node.followerCount,
    node.edge_followed_by?.count,
  );
  const following = firstFiniteMetricNumber(
    node.following_count,
    node.followingCount,
    node.edge_follow?.count,
  );
  const recentViews = firstFiniteMetricNumber(
    node.profile_view_count,
    node.profileViewCount,
    node.total_profile_visits,
    node.profile_visits,
    profileInfo.profile_view_count,
    profileInfo.profileViewCount,
    profileInfo.total_profile_visits,
    insightInfo.profile_view_count,
    insightInfo.profile_visits,
  );
  if (typeof followers === "number") out.followers = followers;
  if (typeof following === "number") out.following = following;
  if (typeof recentViews === "number") out.recentViews = recentViews;
  return out;
}

export function extractThreadsProfileUserStats(html: string, usernameInput: string): Partial<ThreadsProfileHotMetrics> {
  const username = String(usernameInput || "").replace(/^@+/, "").trim().toLowerCase();
  const out: Partial<ThreadsProfileHotMetrics> = {};
  if (!username) return out;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = String(html || "");
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = String(match[1] || "").trim();
    if (!raw || (!raw.includes("follower_count") && !raw.includes("followerCount") && !raw.includes("profile_view"))) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJsonObjects(parsed, (node) => {
      mergeThreadsProfileIdentityMetrics(out, threadsProfileIdentityMetricsFromUserNode(node, username));
    });
  }
  if (typeof out.followers !== "number") {
    const followerMatch = source.match(new RegExp(`"username"\\s*:\\s*"${escaped}"[\\s\\S]{0,2000}?"follower_count"\\s*:\\s*(\\d+)`))
      || source.match(new RegExp(`"follower_count"\\s*:\\s*(\\d+)[\\s\\S]{0,2000}?"username"\\s*:\\s*"${escaped}"`));
    if (followerMatch?.[1]) out.followers = Number(followerMatch[1]);
  }
  if (typeof out.following !== "number") {
    const followingMatch = source.match(new RegExp(`"username"\\s*:\\s*"${escaped}"[\\s\\S]{0,2000}?"following_count"\\s*:\\s*(\\d+)`))
      || source.match(new RegExp(`"following_count"\\s*:\\s*(\\d+)[\\s\\S]{0,2000}?"username"\\s*:\\s*"${escaped}"`));
    if (followingMatch?.[1]) out.following = Number(followingMatch[1]);
  }
  if (typeof out.recentViews !== "number") {
    const viewMatch = source.match(new RegExp(`"username"\\s*:\\s*"${escaped}"[\\s\\S]{0,2400}?"(?:profile_view_count|total_profile_visits)"\\s*:\\s*(\\d+)`))
      || source.match(new RegExp(`"(?:profile_view_count|total_profile_visits)"\\s*:\\s*(\\d+)[\\s\\S]{0,2400}?"username"\\s*:\\s*"${escaped}"`));
    if (viewMatch?.[1]) out.recentViews = Number(viewMatch[1]);
  }
  return out;
}

export function extractThreadsProfileHttpPayloads(html: string): any[] {
  const payloads: any[] = [];
  const seen = new Set<string>();
  for (const match of String(html || "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = String(match[1] || "").trim();
    if (!raw || !raw.includes("thread_items")) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJsonObjects(parsed, (node) => {
      const edges = Array.isArray(node?.edges) ? node.edges : [];
      if (!edges.some((edge: any) => Array.isArray(edge?.node?.thread_items))) return;
      const key = JSON.stringify([
        node?.page_info?.end_cursor || "",
        edges.map((edge: any) => edge?.node?.thread_items?.[0]?.post?.pk || ""),
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      payloads.push({ data: { mediaData: node } });
    });
  }
  return payloads;
}

const THREADS_PROFILE_TAB_DOC_ID = "27090536597286483";
const THREADS_PROFILE_TAB_RELAY_FLAGS = [
  "__relay_internal__pv__BarcelonaIsLoggedInrelayprovider",
  "__relay_internal__pv__BarcelonaHasProfileSelfReplyContextrelayprovider",
  "__relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider",
  "__relay_internal__pv__BarcelonaHasEventBadgerelayprovider",
  "__relay_internal__pv__BarcelonaGenAIRepliesEnabledrelayprovider",
  "__relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider",
  "__relay_internal__pv__BarcelonaHasCommunitiesrelayprovider",
  "__relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider",
  "__relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider",
  "__relay_internal__pv__BarcelonaHasCommunityEmojiUpdateCardrelayprovider",
  "__relay_internal__pv__BarcelonaHasCommunityEntityCardrelayprovider",
  "__relay_internal__pv__BarcelonaHasScorecardCommunityrelayprovider",
  "__relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider",
  "__relay_internal__pv__BarcelonaHasMusicrelayprovider",
  "__relay_internal__pv__BarcelonaHasNewspaperLinkStylerelayprovider",
  "__relay_internal__pv__BarcelonaHasMessagingrelayprovider",
  "__relay_internal__pv__BarcelonaHasPodcastV2Consumptionrelayprovider",
  "__relay_internal__pv__BarcelonaHasPodcastTranscriptConsumptionrelayprovider",
  "__relay_internal__pv__BarcelonaShouldFulfillLightboxQueryrelayprovider",
  "__relay_internal__pv__BarcelonaHasViewerRepliedrelayprovider",
  "__relay_internal__pv__BarcelonaHasPrivateRepliesDeprecationrelayprovider",
  "__relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider",
  "__relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider",
  "__relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider",
  "__relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider",
  "__relay_internal__pv__BarcelonaIsCrawlerrelayprovider",
  "__relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider",
  "__relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider",
  "__relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider",
  "__relay_internal__pv__BarcelonaIsInternalUserrelayprovider",
] as const;

function extractThreadsHtmlBootToken(html: string, moduleName: string): string {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(html || "").match(new RegExp(`\\["${escaped}",\\[\\],\\{"token":"([^"]+)"\\}`));
  return match?.[1] || "";
}

export function extractThreadsProfileUserId(html: string, username: string): string {
  const escaped = String(username || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = String(html || "");
  const patterns = [
    new RegExp(`"username"\\s*:\\s*"${escaped}"[\\s\\S]{0,480}?"pk"\\s*:\\s*"(\\d{5,14})"`),
    new RegExp(`"pk"\\s*:\\s*"(\\d{5,14})"[\\s\\S]{0,480}?"username"\\s*:\\s*"${escaped}"`),
    new RegExp(`"username"\\s*:\\s*"${escaped}"[\\s\\S]{0,480}?"id"\\s*:\\s*"(\\d{5,14})"`),
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function profileMetricsHttpOnly(): boolean {
  return /^(?:1|true|yes|on)$/i.test(cleanText(
    process.env.TG_THREADS_PROFILE_HTTP_ONLY || process.env.TG_COLLECTOR_PROFILE_REQUIRED,
  ));
}

function cookieValueByName(cookies: any[], name: string): string {
  const wanted = String(name || "").trim().toLowerCase();
  const found = (Array.isArray(cookies) ? cookies : []).find((cookie: any) => (
    cleanText(cookie?.name).toLowerCase() === wanted
  ));
  return cleanText(found?.value);
}

function threadsProfileTabRelayVariables(args: {
  userId: string;
  username: string;
  after?: string;
}): Record<string, any> {
  const variables: Record<string, any> = {
    id: args.userId,
    userID: args.userId,
    username: args.username,
    after: args.after || null,
    before: null,
    first: 50,
    last: null,
  };
  for (const flag of THREADS_PROFILE_TAB_RELAY_FLAGS) {
    variables[flag] = !/BarcelonaIsCrawler|BarcelonaIsInternalUser|BarcelonaIsLoggedOut/.test(flag);
  }
  return variables;
}

async function paginateThreadsProfileGraphqlPages(args: {
  username: string;
  html: string;
  cookies: any[];
  proxyUrl?: string;
  initialCursor?: string;
  hasNextPage: boolean;
}): Promise<{ posts: ThreadsGraphqlProfilePostAggregate[]; reachedEnd: boolean }> {
  const userId = extractThreadsProfileUserId(args.html, args.username);
  const lsd = extractThreadsHtmlBootToken(args.html, "LSD");
  const dtsg = extractThreadsHtmlBootToken(args.html, "DTSGInitialData");
  const csrf = cookieValueByName(args.cookies, "csrftoken");
  if (!userId || !lsd || !csrf || !args.hasNextPage || !args.initialCursor) {
    return { posts: [], reachedEnd: false };
  }
  const posts: ThreadsGraphqlProfilePostAggregate[] = [];
  let cursor = args.initialCursor;
  let reachedEnd = false;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < 120 && cursor; pageIndex += 1) {
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    const body = new URLSearchParams({
      lsd,
      doc_id: THREADS_PROFILE_TAB_DOC_ID,
      variables: JSON.stringify(threadsProfileTabRelayVariables({
        userId,
        username: args.username,
        after: cursor,
      })),
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "BarcelonaProfileThreadsTabDirectQuery",
      server_timestamps: "true",
      ...(dtsg ? { fb_dtsg: dtsg } : {}),
    }).toString();
    const response = await requestSessionHttpText({
      url: "https://www.threads.com/api/graphql",
      cookies: args.cookies,
      proxyUrl: args.proxyUrl,
      method: "POST",
      body,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "x-fb-lsd": lsd,
        "x-csrftoken": csrf,
        "x-fb-friendly-name": "BarcelonaProfileThreadsTabDirectQuery",
        "x-ig-app-id": "238260118351668",
        "x-asbd-id": "359341",
        origin: "https://www.threads.com",
        referer: buildThreadsProfileUrl(args.username),
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      timeoutMs: 8_000,
    }).catch(() => null);
    const payload = safeJson(response?.text || "");
    if (!response?.ok || !payload || payload?.errors) break;
    const page = parseThreadsGraphqlProfilePagePayload({ username: args.username, payload });
    for (const post of page.posts) posts.push(post);
    if (page.pageInfoResolved && page.hasNextPage !== true) {
      reachedEnd = true;
      break;
    }
    if (!page.endCursor || page.endCursor === cursor) break;
    cursor = page.endCursor;
  }
  return { posts, reachedEnd };
}

export async function fetchThreadsProfileIdentityMetrics(usernameInput: string): Promise<Partial<ThreadsProfileHotMetrics>> {
  const username = String(usernameInput || "").replace(/^@+/, "").trim();
  if (!username) return {};
  const profileUrl = buildThreadsProfileUrl(username);
  try {
    const response = await requestSessionHttpText({
      url: profileUrl,
      cookies: [],
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
      timeoutMs: 8_000,
    });
    if (!response.ok) return {};
    const parsed = parseThreadsProfileHotMetricsText(spiderHtmlToReaderText(response.text, profileUrl));
    const userStats = extractThreadsProfileUserStats(response.text, username);
    const out: Partial<ThreadsProfileHotMetrics> = { ...userStats };
    if (typeof parsed.followers === "number") out.followers = parsed.followers;
    if (typeof parsed.following === "number") out.following = parsed.following;
    if (typeof parsed.recentViews === "number") out.recentViews = parsed.recentViews;
    return out;
  } catch {
    return {};
  }
}

async function fetchThreadsProfileHotMetricsHttp(username: string): Promise<ThreadsProfileHotMetrics> {
  const refreshedAt = new Date().toISOString();
  const cookies = readSentimentBrowserAuthCookies("threads");
  const hasSession = hasThreadsProfileLoginSessionCookie(cookies);
  const profileUrl = buildThreadsProfileUrl(username);
  try {
    const profileHeaders = {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    };
    const response = await requestSessionHttpText({
      url: profileUrl,
      cookies: [],
      headers: profileHeaders,
      timeoutMs: 8_000,
    });
    const readerText = spiderHtmlToReaderText(response.text, profileUrl);
    if (!response.ok || /\/login(?:[/?]|$)/i.test(response.url) || detectThreadsProfileLoginWall(readerText)) {
      throw new Error(`Threads HTTP 登录态不可用（HTTP ${response.status || 0}）。`);
    }
    const byKey = new Map<string, ThreadsGraphqlProfilePostAggregate>();
    let reachedEnd = false;
    let initialCursor = "";
    let initialHasNext = false;
    for (const payload of extractThreadsProfileHttpPayloads(response.text)) {
      const page = parseThreadsGraphqlProfilePagePayload({ username, payload });
      if (page.pageInfoResolved && page.hasNextPage !== true) reachedEnd = true;
      if (page.hasNextPage && page.endCursor) {
        initialHasNext = true;
        initialCursor = page.endCursor;
      }
      for (const post of page.posts) {
        const key = resolveThreadsProfilePostMergeKey(post);
        if (key) byKey.set(key, { ...(byKey.get(key) || {}), ...post });
      }
    }
    if (!reachedEnd && initialHasNext && initialCursor) {
      const extra = await paginateThreadsProfileGraphqlPages({
        username,
        html: response.text,
        cookies,
        initialCursor,
        hasNextPage: true,
      }).catch(() => ({ posts: [] as ThreadsGraphqlProfilePostAggregate[], reachedEnd: false }));
      for (const post of extra.posts) {
        const key = resolveThreadsProfilePostMergeKey(post);
        if (key) byKey.set(key, { ...(byKey.get(key) || {}), ...post });
      }
      if (extra.reachedEnd) reachedEnd = true;
    }
    const parsed = parseThreadsProfileHotMetricsText(readerText);
    const userStats = extractThreadsProfileUserStats(response.text, username);
    const posts = [...byKey.values()];
    if (!posts.length) throw new Error("Threads HTTP 页面未返回可识别的账号帖子。");
    const postMetrics = posts.map((post) => ({
      pk: post.pk,
      code: post.code,
      sourceUrl: post.sourceUrl,
      ...(post.content ? { content: post.content } : {}),
      ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
      likeCount: post.likeCount,
      commentCount: post.commentCount,
      repostCount: post.repostCount,
      shareCount: post.shareCount,
      ...(typeof post.viewCount === "number" ? { viewCount: post.viewCount } : {}),
      capturedAt: refreshedAt,
    } satisfies ThreadsProfilePostHotMetrics));
    const resolvedViews = postMetrics.filter((post) => typeof post.viewCount === "number").length;
    const declaredPosts = typeof parsed.posts === "number" ? parsed.posts : postMetrics.length;
    const complete = hasSession
      && reachedEnd
      && postMetrics.length >= declaredPosts;
    return {
      platform: "threads",
      username,
      ...parsed,
      ...userStats,
      ...(typeof parsed.followers === "number" ? { followers: parsed.followers } : {}),
      ...(typeof parsed.following === "number" ? { following: parsed.following } : {}),
      ...(typeof parsed.recentViews === "number" ? { recentViews: parsed.recentViews } : {}),
      posts: Math.max(declaredPosts, postMetrics.length),
      likes: postMetrics.reduce((sum, post) => sum + Number(post.likeCount || 0), 0),
      comments: postMetrics.reduce((sum, post) => sum + Number(post.commentCount || 0), 0),
      reposts: postMetrics.reduce((sum, post) => sum + Number(post.repostCount || 0), 0),
      shares: postMetrics.reduce((sum, post) => sum + Number(post.shareCount || 0), 0),
      views: postMetrics.reduce((sum, post) => sum + Number(post.viewCount || 0), 0),
      viewResolvedPosts: resolvedViews,
      viewMissingPosts: Math.max(0, postMetrics.length - resolvedViews),
      scannedPosts: postMetrics.length,
      postMetrics,
      refreshedAt,
      method: "http",
      complete,
      scope: complete ? "authenticated_full_profile" : "public_partial",
      error: complete ? undefined : "Threads HTTP 已读取账号快照，但 GraphQL 游标尚未完整。",
    };
  } catch (error: any) {
    return {
      platform: "threads",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: error instanceof Error
        ? (error.cause ? `${error.message}: ${String((error.cause as any)?.code || (error.cause as any)?.message || error.cause)}` : error.message)
        : String(error || "Threads HTTP 刷新失败。"),
    };
  }
}

export async function fetchThreadsProfileLightMetrics(usernameInput: string): Promise<ThreadsProfileHotMetrics> {
  const username = String(usernameInput || "").replace(/^@+/, "").trim();
  const refreshedAt = new Date().toISOString();
  if (!username) {
    return {
      platform: "threads",
      username,
      refreshedAt,
      lightRefreshedAt: refreshedAt,
      method: "failed",
      error: "Threads 帐号未设定，无法刷新轻量热点数据",
    };
  }
  const profileUrl = buildThreadsProfileUrl(username);
  const cookies = readSentimentBrowserAuthCookies("threads");
  if (!process.env.VITEST_WORKER_ID) {
    const hasLoginSessionCookie = hasThreadsProfileLoginSessionCookie(cookies);
    const cookieAttempts = hasLoginSessionCookie
      ? [cookies, []]
      : [[]];
    for (const attemptCookies of cookieAttempts) {
      let browser: any = null;
      try {
      const playwright = await import("playwright");
      browser = await playwright.chromium.launch(buildLocalChromiumLaunchOptions());
      const context = await browser.newContext({
        viewport: { width: 900, height: 1400 },
        locale: "zh-TW",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      });
      if (attemptCookies.length) await addCookiesBestEffort(context, attemptCookies);
      const page = await context.newPage();
      await page.goto(profileUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      }).catch(() => null);
      await page.waitForTimeout(2200);
      const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
      const buttonText = await page.$$eval("[role=button],button,a", (items) => items
        .map((item) => (item.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 120)).catch(() => []);
      const links = await page.$$eval("a[href]", (items: any[]) => items
        .map((item: any) => item.href || item.getAttribute?.("href") || "")
        .filter(Boolean)).catch(() => []);
      const visible = analyzeThreadsProfileVisibleSignals({ username, bodyText, buttonText, links });
      if (detectThreadsProfileLoginWall(visible.text) && !visible.hasUsableProfileSignals) {
        return buildThreadsProfileIncompleteMetrics(username, refreshedAt, "failed", visible.rawText);
      }
      const parsed = visible.parsed || {};
      if (
        typeof parsed.followers === "number"
        || typeof parsed.following === "number"
        || typeof parsed.recentViews === "number"
        || typeof parsed.views === "number"
      ) {
        return {
          platform: "threads",
          username,
          followers: parsed.followers,
          following: parsed.following,
          recentViews: parsed.recentViews ?? parsed.views,
          refreshedAt,
          lightRefreshedAt: refreshedAt,
          method: "browser",
          complete: true,
          scope: "profile_visible_light",
          rawText: visible.rawText.slice(0, 4000),
        };
      }
    } catch {
      // Fall through to the explicit incomplete result below.
    } finally {
      await browser?.close().catch(() => undefined);
    }
    }
  }
  return buildThreadsProfileIncompleteMetrics(username, refreshedAt, "failed");
}

export async function fetchThreadsProfileHotMetrics(usernameInput: string): Promise<ThreadsProfileHotMetrics> {
  const username = String(usernameInput || "").replace(/^@+/, "").trim();
  const refreshedAt = new Date().toISOString();
  if (!username) {
    return {
      platform: "threads",
      username,
      refreshedAt,
      method: "failed",
      error: "Threads 帳號未設定，無法刷新熱點資料",
    };
  }
  const profileUrl = buildThreadsProfileUrl(username);
  const cookies = readSentimentBrowserAuthCookies("threads");
  let bestHttpMetrics: ThreadsProfileHotMetrics | null = null;
  if (!process.env.VITEST_WORKER_ID) {
    bestHttpMetrics = await fetchThreadsProfileHotMetricsHttp(username);
    if (bestHttpMetrics.complete === true) return bestHttpMetrics;
    if (profileMetricsHttpOnly()) return bestHttpMetrics;
    const hasLoginSessionCookie = hasThreadsProfileLoginSessionCookie(cookies);
    const cookieAttempts = hasLoginSessionCookie
      ? [cookies, []]
      : [[]];
    let bestBrowserMetrics: ThreadsProfileHotMetrics | null = null;
    for (const attemptCookies of cookieAttempts) {
      let browser: any = null;
      try {
      const playwright = await import("playwright");
      browser = await playwright.chromium.launch(buildLocalChromiumLaunchOptions());
      const context = await browser.newContext({
        viewport: { width: 900, height: 1400 },
        locale: "zh-TW",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      });
      if (attemptCookies.length) await addCookiesBestEffort(context, attemptCookies);
      const page = await context.newPage();
      const capturedGraphqlPages = new Map<string, { payload: any; template: ThreadsGraphqlRequestTemplate }>();
      let initialGraphqlPayload: any = null;
      let initialGraphqlTemplate: ThreadsGraphqlRequestTemplate | null = null;
      page.on("response", async (response: any) => {
        try {
          if (!/graphql\/query/i.test(String(response.url?.() || response.url || ""))) return;
          const request = response.request?.();
          const postData = request?.postData?.() || "";
          const template = parseThreadsGraphqlRequestTemplate(postData);
          if (!template) return;
          const payload = safeJson(await response.text().catch(() => ""));
          if (!payload?.data?.mediaData?.edges) return;
          const afterKey = cleanText(template.variables?.after) || "__FIRST__";
          capturedGraphqlPages.set(afterKey, { payload, template });
          if (template.variables?.after == null || template.variables?.after === "") {
            initialGraphqlTemplate = template;
            initialGraphqlPayload = payload;
            return;
          }
          if (!initialGraphqlPayload || !initialGraphqlTemplate) {
            initialGraphqlTemplate = template;
            initialGraphqlPayload = payload;
          }
        } catch {
          // Ignore listener failures and fall back to the existing partial path below.
        }
      });
      await page.goto(profileUrl, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      }).catch(() => null);
      await page.waitForTimeout(3500);
      await page.waitForFunction((targetUsername: string) => {
        const text = String(document.body?.innerText || "");
        return text.includes(targetUsername)
          && /(串文|Threads)/i.test(text)
          && /(回覆|回复|Replies?)/i.test(text);
      }, username, { timeout: 12_000 }).catch(() => undefined);
      const visibleProfilePosts = new Map<string, ThreadsGraphqlProfilePostAggregate>();
      const seedVisiblePosts = async () => {
        const posts = await extractThreadsVisibleProfilePosts({ page, username }).catch(() => []);
        if (process.env.THREADS_PROFILE_DEBUG_VISIBLE === "1") {
          console.log("[threads-profile-visible]", JSON.stringify({ username, count: posts.length, codes: posts.slice(0, 12).map((post) => post.code) }));
        }
        for (const post of posts) {
          const key = resolveThreadsProfilePostMergeKey(post);
          if (key) visibleProfilePosts.set(key, post);
        }
      };
      await seedVisiblePosts();
      const initialBodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
      const initialButtonText = await page.$$eval("[role=button],button,a", (items) => items
        .map((item) => (item.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 160)).catch(() => []);
      const initialLinks = await page.$$eval("a[href]", (items: any[]) => items
        .map((item: any) => item.href || item.getAttribute?.("href") || "")
        .filter(Boolean)).catch(() => []);
      await seedVisiblePosts();
      const visibleReachedEnd = await scrollThreadsProfileUntilGraphqlEnd({
        page,
        capturedGraphqlPages,
        username,
        afterScroll: seedVisiblePosts,
      });
      await seedVisiblePosts();
      const bodyText = await page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
      const buttonText = await page.$$eval("[role=button],button,a", (items) => items
        .map((item) => (item.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 120)).catch(() => []);
      const links = await page.$$eval("a[href]", (items: any[]) => items
        .map((item: any) => item.href || item.getAttribute?.("href") || "")
        .filter(Boolean)).catch(() => []);
      const visible = analyzeThreadsProfileVisibleSignals({
        username,
        bodyText: [initialBodyText, bodyText].filter(Boolean).join("\n"),
        buttonText: [...initialButtonText, ...buttonText],
        links: [...initialLinks, ...links],
      });
      if (detectThreadsProfileLoginWall(visible.text) && !visible.hasUsableProfileSignals) {
        if (attemptCookies.length && bestBrowserMetrics) return bestBrowserMetrics;
        if (attemptCookies.length) continue;
        continue;
      }
      let parsed = { ...visible.parsed };
      if ((initialGraphqlPayload && initialGraphqlTemplate) || visibleProfilePosts.size > 0) {
        const collection = initialGraphqlPayload && initialGraphqlTemplate
          ? await collectThreadsGraphqlProfilePosts({
            page,
            username,
            initialPayload: initialGraphqlPayload,
            initialTemplate: initialGraphqlTemplate,
          }).catch(() => ({ posts: [], reachedEnd: false }))
          : { posts: [], reachedEnd: false };
        const seededPosts = new Map<string, ThreadsGraphqlProfilePostAggregate>();
        const capturedPageCount = capturedGraphqlPages.size;
        let capturedReachedEnd = false;
        for (const post of visibleProfilePosts.values()) {
          const key = resolveThreadsProfilePostMergeKey(post);
          if (key) seededPosts.set(key, post);
        }
        for (const { payload } of capturedGraphqlPages.values()) {
          const pageResult = parseThreadsGraphqlProfilePagePayload({ username, payload });
          if (pageResult.pageInfoResolved && pageResult.hasNextPage !== true) capturedReachedEnd = true;
          for (const post of pageResult.posts) {
            const key = resolveThreadsProfilePostMergeKey(post);
            if (key) seededPosts.set(key, { ...(seededPosts.get(key) || {}), ...post });
          }
        }
        for (const post of collection.posts) {
          const key = resolveThreadsProfilePostMergeKey(post);
          if (key) seededPosts.set(key, { ...(seededPosts.get(key) || {}), ...post });
        }
        const allPosts = [...seededPosts.values()].sort((a, b) => {
          const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
          const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
          if (bTime !== aTime) return bTime - aTime;
          return String(b.pk || "").localeCompare(String(a.pk || ""));
        });
        if (allPosts.length) {
          const views = await collectThreadsViewCountsFromPostPages({
            context,
            posts: allPosts,
          }).catch(() => ({ totalViews: 0, resolvedPosts: 0 }));
          const viewsByUrl = (views as any).viewsByUrl || {};
          const postMetrics = allPosts
            .map((post) => ({
              pk: post.pk,
              code: post.code,
              sourceUrl: post.sourceUrl,
              ...(post.content ? { content: post.content } : {}),
              ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
              likeCount: post.likeCount,
              commentCount: post.commentCount,
              repostCount: post.repostCount,
              shareCount: post.shareCount,
              viewCount: typeof viewsByUrl[post.sourceUrl] === "number" ? viewsByUrl[post.sourceUrl] : post.viewCount,
              capturedAt: refreshedAt,
            }))
            .filter((post) => !isSuspiciousThreadsProfileMetricMix(post));
          const resolvedViewPosts = postMetrics.filter((post) => typeof post.viewCount === "number").length;
          const totalResolvedViews = postMetrics.reduce((sum, post) => sum + (typeof post.viewCount === "number" ? post.viewCount : 0), 0);
          const visiblePostTotal = Number(visible.parsed.posts);
          const reachedEndByVisibleTotal = Number.isFinite(visiblePostTotal)
            && visiblePostTotal > 0
            && allPosts.length >= visiblePostTotal;
          parsed = {
            ...visible.parsed,
            posts: Math.max(Number(visible.parsed.posts || 0), postMetrics.length),
            scannedPosts: postMetrics.length,
            likes: postMetrics.reduce((sum, post) => sum + (post.likeCount || 0), 0),
            comments: postMetrics.reduce((sum, post) => sum + (post.commentCount || 0), 0),
            reposts: postMetrics.reduce((sum, post) => sum + (post.repostCount || 0), 0),
            shares: postMetrics.reduce((sum, post) => sum + (post.shareCount || 0), 0),
            ...(resolvedViewPosts > 0 ? { views: totalResolvedViews } : {}),
            viewResolvedPosts: resolvedViewPosts,
            viewMissingPosts: Math.max(0, postMetrics.length - resolvedViewPosts),
            postMetrics,
          };
          (parsed as any).profileReachedEnd = capturedReachedEnd
            || collection.reachedEnd
            || visibleReachedEnd
            || reachedEndByVisibleTotal;
        }
      } else {
        parsed = {
          ...parsed,
          ...(await buildThreadsProfileAggregateMetricsFromBrowserPage({ page, username, links })),
        };
      }
      if (!Array.isArray((parsed as any).postMetrics) || (parsed as any).postMetrics.length === 0) {
        delete (parsed as any).scannedPosts;
        delete (parsed as any).likes;
        delete (parsed as any).comments;
        delete (parsed as any).reposts;
        delete (parsed as any).shares;
        delete (parsed as any).views;
      }
      const authenticatedProfileComplete = attemptCookies.length > 0
        && typeof parsed.scannedPosts === "number"
        && parsed.scannedPosts > 0
        && Array.isArray((parsed as any).postMetrics)
        && (parsed as any).postMetrics.length >= parsed.scannedPosts
        && Number((parsed as any).viewMissingPosts || 0) === 0
        && (parsed as any).profileReachedEnd === true;
      const visibleProfileComplete = !hasLoginSessionCookie
        && !attemptCookies.length
        && threadsProfileHotMetricsHasValue(parsed)
        && typeof parsed.scannedPosts === "number"
        && parsed.scannedPosts > 0
        && typeof parsed.views === "number"
        && (parsed as any).profileReachedEnd === true;
      const complete = authenticatedProfileComplete || visibleProfileComplete;
      if (threadsProfileHotMetricsHasValue(parsed)) {
        const { profileReachedEnd: _profileReachedEnd, ...publicParsed } = parsed as any;
        const browserMetrics: ThreadsProfileHotMetrics = {
          platform: "threads",
          username,
          ...publicParsed,
          refreshedAt,
          method: "browser",
          complete,
          scope: complete && attemptCookies.length ? "authenticated_full_profile" : complete ? "profile_visible_light" : "public_partial",
          rawText: visible.rawText.slice(0, 4000),
          error: complete ? undefined : "Threads live login was not verified or profile pagination did not reach the end; only partial public profile data was read, so this result cannot be treated as full account metrics.",
        };
        if (complete || attemptCookies.length || !hasLoginSessionCookie) return browserMetrics;
        bestBrowserMetrics = browserMetrics;
      }
    } catch {
      // Fall through to the explicit incomplete result below.
    } finally {
      await browser?.close?.().catch?.(() => null);
    }
    }
    if (bestBrowserMetrics) return bestBrowserMetrics;
    if (bestHttpMetrics && threadsProfileHotMetricsHasValue(bestHttpMetrics)) return bestHttpMetrics;
  }
  if (process.env.THREADS_PROFILE_ALLOW_PARTIAL_READER === "1") {
  try {
    const readerTargetUrl = `${profileUrl}?__r=${Date.now().toString(36)}`;
    const response = await fetchWithSharedPublicCrawlerLimit(readerTargetUrl, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "text/plain, text/markdown, */*",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    }, 15_000, "bypass");
    const text = response.ok ? await response.text() : "";
    const links = Array.from(text.matchAll(/https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[^)\]\s]+\/post\/[^)\]\s]+/gi))
      .map((match) => match[0]);
    const parsed = {
      ...parseThreadsProfileHotMetricsText(text),
      ...(await buildThreadsProfileAggregateMetrics({ username, text, links })),
    };
    return {
      platform: "threads",
      username,
      ...parsed,
      refreshedAt,
      method: threadsProfileHotMetricsHasValue(parsed) ? "reader" : "failed",
      rawText: text.slice(0, 4000),
      error: threadsProfileHotMetricsHasValue(parsed) ? undefined : "未從 Threads Profile 讀取到可用熱點資料",
    };
  } catch (error: any) {
    return {
      platform: "threads",
      username,
      refreshedAt,
      method: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  }
  return buildThreadsProfileIncompleteMetrics(username, refreshedAt, "failed");
}

function instagramProfileMediaRows(user: any): any[] {
  const edgeGroups = [
    user?.edge_owner_to_timeline_media?.edges,
    user?.edge_felix_video_timeline?.edges,
    user?.timeline_media?.edges,
    user?.feed?.edges,
  ];
  const rows = edgeGroups
    .flatMap((group) => Array.isArray(group) ? group : [])
    .map((edge: any) => edge?.node || edge?.media || edge)
    .filter((row: any) => row && typeof row === "object");
  const byId = new Map<string, any>();
  for (const row of rows) {
    const key = cleanText(row?.id || row?.pk || row?.shortcode || row?.code);
    if (key && !byId.has(key)) byId.set(key, row);
  }
  return [...byId.values()];
}

function instagramProfileMetricNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function instagramPostCodeFromUrl(value: unknown): string {
  const match = cleanText(value).match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  return cleanText(match?.[1]);
}

export function instagramMediaPkFromShortcode(shortcodeInput: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const shortcode = cleanText(shortcodeInput);
  if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) return "";
  let value = 0n;
  for (const character of shortcode) {
    const index = alphabet.indexOf(character);
    if (index < 0) return "";
    value = (value * 64n) + BigInt(index);
  }
  return value.toString();
}

export function parseInstagramPostHotMetricPayload(args: {
  payload: any;
  sourceUrl: string;
  refreshedAt?: string;
}): ThreadsProfilePostHotMetrics | null {
  const item = Array.isArray(args.payload?.items)
    ? args.payload.items[0]
    : args.payload?.item || args.payload?.data?.item;
  if (!item || typeof item !== "object") return null;
  const sourceUrl = cleanText(args.sourceUrl);
  const code = cleanText(item.code || item.shortcode || instagramPostCodeFromUrl(sourceUrl));
  const normalizedSourceUrl = sourceUrl || (code ? `https://www.instagram.com/p/${encodeURIComponent(code)}/` : "");
  if (!normalizedSourceUrl && !item.pk && !item.id) return null;
  const caption = cleanText(item.caption?.text || item.caption);
  return {
    pk: cleanText(item.pk || item.id) || undefined,
    code: code || undefined,
    sourceUrl: normalizedSourceUrl,
    content: caption || undefined,
    publishedAt: normalizeThreadsTimestamp(item.taken_at_timestamp || item.taken_at || item.device_timestamp),
    likeCount: instagramProfileMetricNumber(item.like_count, item?.edge_media_preview_like?.count, item?.edge_liked_by?.count),
    commentCount: instagramProfileMetricNumber(item.comment_count, item?.edge_media_to_comment?.count),
    viewCount: instagramProfileMetricNumber(
      item.content_views_count,
      item.play_count,
      item.view_count,
      item.video_view_count,
      item.video_play_count,
    ),
    capturedAt: args.refreshedAt || new Date().toISOString(),
  };
}

export function parseInstagramProfileHotMetricsPayload(args: {
  payload: any;
  username: string;
  refreshedAt?: string;
}): InstagramProfileHotMetrics {
  const refreshedAt = args.refreshedAt || new Date().toISOString();
  const requestedUsername = cleanText(args.username).replace(/^@+/, "");
  const user = args.payload?.data?.user || args.payload?.user || args.payload?.data?.xdt_api__v1__users__web_profile_info?.user;
  if (!user || typeof user !== "object") {
    return {
      platform: "instagram",
      username: requestedUsername,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: "Instagram 未返回账号资料，请确认后台授权账号仍处于登录状态。",
    };
  }
  const username = cleanText(user.username || requestedUsername).replace(/^@+/, "");
  const mediaRows = instagramProfileMediaRows(user);
  const postMetrics: ThreadsProfilePostHotMetrics[] = mediaRows.map((row: any) => {
    const code = cleanText(row.shortcode || row.code);
    const isVideo = Boolean(row.is_video || row.media_type === 2 || row.product_type === "clips");
    const captionEdges = Array.isArray(row?.edge_media_to_caption?.edges) ? row.edge_media_to_caption.edges : [];
    const caption = cleanText(row.caption?.text || row.caption || captionEdges[0]?.node?.text);
    const sourceUrl = code
      ? `https://www.instagram.com/${isVideo ? "reel" : "p"}/${code}/`
      : cleanText(row.permalink || row.url);
    return {
      pk: cleanText(row.pk || row.id) || undefined,
      code: code || undefined,
      sourceUrl,
      content: caption || undefined,
      publishedAt: normalizeThreadsTimestamp(row.taken_at_timestamp || row.taken_at || row.device_timestamp),
      likeCount: instagramProfileMetricNumber(row?.edge_media_preview_like?.count, row?.edge_liked_by?.count, row.like_count),
      commentCount: instagramProfileMetricNumber(row?.edge_media_to_comment?.count, row.comment_count),
      viewCount: instagramProfileMetricNumber(row.content_views_count, row.video_view_count, row.video_play_count, row.play_count, row.view_count),
      capturedAt: refreshedAt,
    };
  }).filter((row) => Boolean(row.sourceUrl || row.pk));
  const resolvedPostCount = instagramProfileMetricNumber(user?.edge_owner_to_timeline_media?.count, user.media_count, user.post_count);
  const posts = resolvedPostCount ?? postMetrics.length;
  const followers = instagramProfileMetricNumber(user?.edge_followed_by?.count, user.follower_count);
  const following = instagramProfileMetricNumber(user?.edge_follow?.count, user.following_count);
  const likes = postMetrics.length || posts === 0 ? postMetrics.reduce((sum, row) => sum + Number(row.likeCount || 0), 0) : undefined;
  const comments = postMetrics.length || posts === 0 ? postMetrics.reduce((sum, row) => sum + Number(row.commentCount || 0), 0) : undefined;
  const resolvedViewRows = postMetrics.filter((row) => typeof row.viewCount === "number");
  const views = resolvedViewRows.length
    ? resolvedViewRows.reduce((sum, row) => sum + Number(row.viewCount || 0), 0)
    : posts === 0 ? 0 : undefined;
  const complete = resolvedPostCount !== undefined && (posts === 0 || postMetrics.length >= posts);
  return {
    platform: "instagram",
    username,
    followers,
    following,
    posts,
    likes,
    comments,
    reposts: 0,
    shares: 0,
    views,
    scannedPosts: postMetrics.length,
    refreshedAt,
    method: "browser",
    complete,
    scope: complete ? "authenticated_full_profile" : "authenticated_profile_snapshot",
    postMetrics,
    error: complete ? undefined : `Instagram 已读取 ${postMetrics.length} 条近期帖子；账号共 ${posts} 条帖子，本次互动数据为近期快照。`,
  };
}

export function buildInstagramProfileHttpMetrics(args: {
  profilePayload: any;
  feedPages: any[];
  username: string;
  reachedEnd: boolean;
  refreshedAt?: string;
}): InstagramProfileHotMetrics {
  const refreshedAt = args.refreshedAt || new Date().toISOString();
  const profile = parseInstagramProfileHotMetricsPayload({
    payload: args.profilePayload,
    username: args.username,
    refreshedAt,
  });
  if (profile.method === "failed") return profile;
  const byKey = new Map<string, ThreadsProfilePostHotMetrics>();
  const add = (row: ThreadsProfilePostHotMetrics | null) => {
    if (!row) return;
    const key = cleanText(row.pk || row.code || row.sourceUrl);
    if (key) byKey.set(key, { ...(byKey.get(key) || {}), ...row });
  };
  for (const row of profile.postMetrics || []) add(row);
  for (const page of args.feedPages || []) {
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      const code = cleanText(item?.code || item?.shortcode);
      const productType = cleanText(item?.product_type).toLowerCase();
      const sourceUrl = code
        ? `https://www.instagram.com/${productType === "clips" ? "reel" : "p"}/${code}/`
        : cleanText(item?.permalink || item?.url);
      add(parseInstagramPostHotMetricPayload({
        payload: { items: [item] },
        sourceUrl,
        refreshedAt,
      }));
    }
  }
  const postMetrics = [...byKey.values()].sort((left, right) => {
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    return rightTime - leftTime;
  });
  const posts = typeof profile.posts === "number" ? profile.posts : postMetrics.length;
  const complete = args.reachedEnd && (posts === 0 || postMetrics.length >= posts);
  const resolvedViews = postMetrics.filter((row) => typeof row.viewCount === "number");
  return {
    ...profile,
    posts: Math.max(posts, postMetrics.length),
    likes: postMetrics.length || posts === 0
      ? postMetrics.reduce((sum, row) => sum + Number(row.likeCount || 0), 0)
      : profile.likes,
    comments: postMetrics.length || posts === 0
      ? postMetrics.reduce((sum, row) => sum + Number(row.commentCount || 0), 0)
      : profile.comments,
    views: resolvedViews.length
      ? resolvedViews.reduce((sum, row) => sum + Number(row.viewCount || 0), 0)
      : posts === 0 ? 0 : undefined,
    scannedPosts: postMetrics.length,
    postMetrics,
    refreshedAt,
    method: "http",
    complete,
    scope: complete ? "authenticated_full_profile" : "authenticated_profile_snapshot",
    error: complete ? undefined : `Instagram HTTP 已读取 ${postMetrics.length}/${posts} 条帖子，转入浏览器兼容链路。`,
  };
}

async function fetchInstagramProfileHotMetricsHttp(
  username: string,
  publishedUrlsInput: string[],
): Promise<InstagramProfileHotMetrics> {
  const refreshedAt = new Date().toISOString();
  const cookies = readSentimentBrowserAuthCookies("instagram");
  if (!hasValidInstagramSessionCookie(cookies)) {
    return {
      platform: "instagram",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: "Instagram HTTP 登录态缺少有效 sessionid。",
    };
  }
  const csrfToken = cleanText(cookies.find((cookie: any) => cleanText(cookie?.name).toLowerCase() === "csrftoken")?.value);
  const commonHeaders = {
    accept: "*/*",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "x-ig-app-id": "936619743392459",
    "x-requested-with": "XMLHttpRequest",
    ...(csrfToken ? { "x-csrftoken": csrfToken } : {}),
  };
  const proxyUrl = platformProxyUrl("instagram");
  try {
    const profileResponse = await requestSessionHttpText({
      url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      cookies,
      proxyUrl,
      headers: commonHeaders,
      timeoutMs: 20_000,
    });
    const profilePayload = safeJson(profileResponse.text);
    if (!profileResponse.ok || profilePayload?.status === "fail") {
      throw new Error(`Instagram HTTP 账号资料接口返回 ${profileResponse.status || 0}。`);
    }
    const user = profilePayload?.data?.user || profilePayload?.user || profilePayload?.data?.xdt_api__v1__users__web_profile_info?.user;
    const userId = cleanText(user?.id || user?.pk);
    if (!userId) throw new Error("Instagram HTTP 账号资料缺少用户标识。");
    const feedPages: any[] = [];
    const seenCursors = new Set<string>();
    let maxId = "";
    let reachedEnd = false;
    for (let pageIndex = 0; pageIndex < 120; pageIndex += 1) {
      const query = new URLSearchParams({ count: "50" });
      if (maxId) query.set("max_id", maxId);
      const feedResponse = await requestSessionHttpText({
        url: `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?${query.toString()}`,
        cookies,
        proxyUrl,
        headers: commonHeaders,
        timeoutMs: 20_000,
      });
      const page = safeJson(feedResponse.text);
      if (!feedResponse.ok || page?.status === "fail") {
        throw new Error(`Instagram HTTP 帖子分页返回 ${feedResponse.status || 0}。`);
      }
      feedPages.push(page);
      const nextMaxId = cleanText(page?.next_max_id || page?.next_max_id_str);
      if (page?.more_available !== true || !nextMaxId) {
        reachedEnd = true;
        break;
      }
      if (seenCursors.has(nextMaxId)) break;
      seenCursors.add(nextMaxId);
      maxId = nextMaxId;
    }
    return buildInstagramProfileHttpMetrics({
      profilePayload,
      feedPages,
      username,
      reachedEnd,
      refreshedAt,
    });
  } catch (error: any) {
    return {
      platform: "instagram",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: error instanceof Error ? error.message : String(error || "Instagram HTTP 刷新失败。"),
    };
  }
}

export async function fetchInstagramProfileHotMetrics(
  usernameInput: string,
  publishedUrlsInput: string[] = [],
): Promise<InstagramProfileHotMetrics> {
  const username = cleanText(usernameInput).replace(/^@+/, "");
  const refreshedAt = new Date().toISOString();
  if (!username) {
    return {
      platform: "instagram",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: "Instagram 账号未设置，无法刷新热点数据。",
    };
  }
  const cookies = readSentimentBrowserAuthCookies("instagram");
  if (!hasValidInstagramSessionCookie(cookies)) {
    return {
      platform: "instagram",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: "Instagram 后台授权账号未登录或 Cookie 已失效。",
    };
  }
  const bestHttpMetrics = !process.env.VITEST_WORKER_ID
    ? await fetchInstagramProfileHotMetricsHttp(username, publishedUrlsInput)
    : null;
  if (bestHttpMetrics?.complete === true) return bestHttpMetrics;
  if (profileMetricsHttpOnly()) {
    return bestHttpMetrics || {
      platform: "instagram",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: "Instagram HTTP 未返回完整账号资料。",
    };
  }
  let browser: any = null;
  try {
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch(buildLocalChromiumLaunchOptions());
    const context = await browser.newContext({
      viewport: { width: 900, height: 1400 },
      locale: "zh-TW",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    await addCookiesBestEffort(context, cookies);
    const page = await context.newPage();
    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    const csrfToken = cleanText(cookies.find((cookie: any) => cleanText(cookie?.name).toLowerCase() === "csrftoken")?.value);
    const response = await page.evaluate(async ({ targetUsername, csrf }: { targetUsername: string; csrf: string }) => {
      const result = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(targetUsername)}`, {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "*/*",
          "x-ig-app-id": "936619743392459",
          ...(csrf ? { "x-csrftoken": csrf } : {}),
        },
      });
      return { status: result.status, text: await result.text() };
    }, { targetUsername: username, csrf: csrfToken });
    if (Number(response?.status || 0) < 200 || Number(response?.status || 0) >= 300) {
      throw new Error(`Instagram 账号资料接口返回 ${Number(response?.status || 0) || "异常状态"}`);
    }
    const profileMetrics = parseInstagramProfileHotMetricsPayload({
      payload: safeJson(response?.text),
      username,
      refreshedAt,
    });
    const publishedUrls = [...new Set(
      (Array.isArray(publishedUrlsInput) ? publishedUrlsInput : [])
        .map((value) => cleanText(value))
        .filter((value) => Boolean(instagramPostCodeFromUrl(value))),
    )];
    const postMetrics = Array.isArray(profileMetrics.postMetrics) ? [...profileMetrics.postMetrics] : [];
    const knownCodeIndexes = new Map(
      postMetrics
        .map((row, index) => [cleanText(row.code), index] as const)
        .filter(([code]) => Boolean(code)),
    );
    let targetLookupFailures = 0;
    for (const sourceUrl of publishedUrls) {
      const code = instagramPostCodeFromUrl(sourceUrl);
      if (!code) continue;
      const existingIndex = knownCodeIndexes.get(code);
      if (typeof existingIndex === "number" && typeof postMetrics[existingIndex]?.viewCount === "number") continue;
      const mediaPk = instagramMediaPkFromShortcode(code);
      if (!mediaPk) continue;
      try {
        const detailResponse = await page.evaluate(async ({ targetPk, csrf }: { targetPk: string; csrf: string }) => {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), 12_000);
          try {
            const result = await fetch(`/api/v1/media/${encodeURIComponent(targetPk)}/info/`, {
              method: "GET",
              credentials: "include",
              signal: controller.signal,
              headers: {
                accept: "*/*",
                "x-ig-app-id": "936619743392459",
                ...(csrf ? { "x-csrftoken": csrf } : {}),
              },
            });
            return { status: result.status, text: await result.text() };
          } finally {
            window.clearTimeout(timer);
          }
        }, { targetPk: mediaPk, csrf: csrfToken });
        if (Number(detailResponse?.status || 0) < 200 || Number(detailResponse?.status || 0) >= 300) {
          targetLookupFailures += 1;
          continue;
        }
        const row = parseInstagramPostHotMetricPayload({
          payload: safeJson(detailResponse?.text),
          sourceUrl,
          refreshedAt,
        });
        if (!row) {
          targetLookupFailures += 1;
          continue;
        }
        if (typeof existingIndex === "number") {
          postMetrics[existingIndex] = { ...postMetrics[existingIndex], ...row };
        } else {
          postMetrics.push(row);
          knownCodeIndexes.set(code, postMetrics.length - 1);
        }
      } catch {
        targetLookupFailures += 1;
      }
    }
    const posts = profileMetrics.posts;
    const complete = typeof posts === "number" && (posts === 0 || postMetrics.length >= posts);
    const likes = postMetrics.length || posts === 0
      ? postMetrics.reduce((sum, row) => sum + Number(row.likeCount || 0), 0)
      : profileMetrics.likes;
    const comments = postMetrics.length || posts === 0
      ? postMetrics.reduce((sum, row) => sum + Number(row.commentCount || 0), 0)
      : profileMetrics.comments;
    const views = postMetrics.length || posts === 0
      ? postMetrics.reduce((sum, row) => sum + Number(row.viewCount || 0), 0)
      : profileMetrics.views;
    return {
      ...profileMetrics,
      likes,
      comments,
      views,
      scannedPosts: postMetrics.length,
      postMetrics,
      complete,
      scope: complete ? "authenticated_full_profile" : "authenticated_profile_snapshot",
      error: complete
        ? undefined
        : targetLookupFailures
          ? `Instagram 已读取 ${postMetrics.length} 条帖子；${targetLookupFailures} 条已发布链接暂未返回明细。`
          : profileMetrics.error,
    };
  } catch (error: any) {
    if (bestHttpMetrics && (
      Number(bestHttpMetrics.scannedPosts || 0) > 0
      || typeof bestHttpMetrics.followers === "number"
      || typeof bestHttpMetrics.posts === "number"
    )) return bestHttpMetrics;
    return {
      platform: "instagram",
      username,
      refreshedAt,
      method: "failed",
      complete: false,
      scope: "failed",
      error: error instanceof Error ? error.message : String(error || "Instagram 热点数据刷新失败。"),
    };
  } finally {
    await browser?.close?.().catch?.(() => null);
  }
}

function extractEngagementMetricsFromText(value: string): NonNullable<SentimentHotCandidate["engagement"]> {
  const text = String(value || "");
  const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {};
  const assign = (key: keyof NonNullable<SentimentHotCandidate["engagement"]>, pattern: RegExp) => {
    const match = text.match(pattern);
    const count = parseMetricNumber(match?.[1] || match?.[0]);
    if (typeof count === "number") (engagement as any)[key] = count;
  };
  const metricSep = String.raw`[\s:：|｜·•,，。()\[\]{}<>]*`;
  assign("likeCount", new RegExp(String.raw`(?:like|likes|liked|讚|赞|喜歡|喜欢|愛心|爱心|點讚|点赞)${metricSep}(\d+(?:[.,]\d+)?\s*(?:[Kk萬万])?)`, "i"));
  assign("commentCount", new RegExp(String.raw`(?:comment|comments|reply|replies|留言|評論|评论|回覆|回复)${metricSep}(\d+(?:[.,]\d+)?\s*(?:[Kk萬万])?)`, "i"));
  assign("viewCount", new RegExp(String.raw`(?:view|views|watch|play|plays|瀏覽|浏览|觀看|观看|播放|閱讀|阅读|流量)${metricSep}(\d+(?:[.,]\d+)?\s*(?:[Kk萬万])?)`, "i"));
  assign("shareCount", new RegExp(String.raw`(?:share|shares|repost|reposts|轉發|转发|分享)${metricSep}(\d+(?:[.,]\d+)?\s*(?:[Kk萬万])?)`, "i"));
  const rawSignals = Array.from(text.matchAll(/(?:^|\n)\s*\[?(\d+(?:[.,]\d+)?\s*(?:[Kk萬万])?)\]?\s*(?=\n|$)/g))
    .map((match) => parseMetricNumber(match[1]))
    .filter((item): item is number => typeof item === "number" && item > 0)
    .slice(0, 6);
  if (rawSignals.length) engagement.rawSignals = rawSignals;
  return engagement;
}

function realSentimentHotScore(engagement: NonNullable<SentimentHotCandidate["engagement"]>): number {
  const namedTotal = Math.max(0, Number(engagement.likeCount || 0))
    + Math.max(0, Number(engagement.commentCount || 0))
    + Math.max(0, Number(engagement.shareCount || 0));
  const rawTotal = (engagement.rawSignals || [])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .reduce((total, value) => total + value, 0);
  return Math.round(Math.max(Number(engagement.viewCount || 0), namedTotal, rawTotal));
}

function extractInstagramEngagementMetricsFromText(value: string): NonNullable<SentimentHotCandidate["engagement"]> {
  const text = String(value || "");
  const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {};
  const likeCount = parseMetricNumberLoose(text.match(/(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*(?:likes?|讚|赞|喜歡|喜欢)/i)?.[1]);
  const commentCount = parseMetricNumberLoose(text.match(/(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*(?:comments?|留言|評論|评论)/i)?.[1]);
  const viewCount = parseMetricNumberLoose(text.match(/(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*(?:views?|plays?|觀看|观看|播放|瀏覽|浏览)/i)?.[1]);
  const rawSignals = [...text.matchAll(/\]\(https?:\/\/www\.instagram\.com\/[A-Za-z0-9._]+\/?\)\s+(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)(?=\s+[\u3400-\u9fff#\uD800-\uDBFF])/g)]
    .map((match) => parseMetricNumberLoose(match[1]))
    .filter((item): item is number => typeof item === "number" && item > 0)
    .slice(0, 4);
  if (typeof likeCount === "number") engagement.likeCount = likeCount;
  if (typeof commentCount === "number") engagement.commentCount = commentCount;
  if (typeof viewCount === "number") engagement.viewCount = viewCount;
  if (rawSignals.length) engagement.rawSignals = rawSignals;
  return engagement;
}

function mergeEngagementMetrics(
  base: NonNullable<SentimentHotCandidate["engagement"]>,
  extra: NonNullable<SentimentHotCandidate["engagement"]>,
): NonNullable<SentimentHotCandidate["engagement"]> {
  const merged: NonNullable<SentimentHotCandidate["engagement"]> = { ...base };
  if (typeof merged.likeCount !== "number" && typeof extra.likeCount === "number") merged.likeCount = extra.likeCount;
  if (typeof merged.commentCount !== "number" && typeof extra.commentCount === "number") merged.commentCount = extra.commentCount;
  if (typeof merged.viewCount !== "number" && typeof extra.viewCount === "number") merged.viewCount = extra.viewCount;
  if (typeof merged.shareCount !== "number" && typeof extra.shareCount === "number") merged.shareCount = extra.shareCount;
  const rawSignals = [...(base.rawSignals || []), ...(extra.rawSignals || [])]
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0);
  if (rawSignals.length) merged.rawSignals = [...new Set(rawSignals)].slice(0, 8);
  return merged;
}

function refreshEngagementMetrics(
  base: NonNullable<SentimentHotCandidate["engagement"]>,
  latest: NonNullable<SentimentHotCandidate["engagement"]>,
): NonNullable<SentimentHotCandidate["engagement"]> {
  const refreshed: NonNullable<SentimentHotCandidate["engagement"]> = {};
  if (typeof latest.likeCount === "number") refreshed.likeCount = latest.likeCount;
  if (typeof latest.commentCount === "number") refreshed.commentCount = latest.commentCount;
  if (typeof latest.viewCount === "number") refreshed.viewCount = latest.viewCount;
  if (typeof latest.shareCount === "number") refreshed.shareCount = latest.shareCount;
  const rawSignals = (latest.rawSignals || base.rawSignals || [])
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0);
  if (rawSignals.length) refreshed.rawSignals = [...new Set(rawSignals)].slice(0, 8);
  for (const key of ["likeCount", "commentCount", "viewCount", "shareCount"] as const) {
    if (typeof refreshed[key] !== "number") (refreshed as any)[key] = undefined;
  }
  return refreshed;
}

function buildAbortSignalTimeout(ms: number): AbortSignal | undefined {
  const timeout = (AbortSignal as any)?.timeout;
  if (typeof timeout === "function") return timeout(ms);
  if (typeof AbortController !== "function") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function hasNamedEngagementMetrics(engagement?: SentimentHotCandidate["engagement"]) {
  return Boolean(
    engagement
      && (
        typeof engagement.likeCount === "number"
        || typeof engagement.commentCount === "number"
        || typeof engagement.viewCount === "number"
        || typeof engagement.shareCount === "number"
      ),
  );
}

export function parseThreadsDetailEngagementMarkdown(text: string): NonNullable<SentimentHotCandidate["engagement"]> {
  const value = String(text || "");
  const engagement = extractEngagementMetricsFromText(value);
  const viewMatch = value.match(/Thread\s+(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s+views/i);
  const viewCount = parseMetricNumberLoose(viewMatch?.[1]);
  if (typeof viewCount === "number") engagement.viewCount = viewCount;
  const rawSignals = Array.from(value.matchAll(/(?:^|\n)\s*(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*(?=\n|$)/g))
    .map((match) => parseMetricNumberLoose(match[1]))
    .filter((item): item is number => typeof item === "number" && item > 0)
    .slice(0, 8);
  if (rawSignals.length) {
    engagement.rawSignals = [...new Set([...(engagement.rawSignals || []), ...rawSignals])].slice(0, 8);
    if (typeof engagement.likeCount !== "number") engagement.likeCount = rawSignals[0];
  }
  return engagement;
}

function normalizeThreadsPublishedHistoryText(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，,。.!！?？:：;；"'“”‘’`·、（）()[\]{}<>《》【】]/g, "")
    .toLowerCase();
}

function isThreadsProfilePostTimeLine(value: string): boolean {
  return /^(?:\d+\s*)?(?:秒|分鐘|分钟|小時|小时|天|週|周|月|年|s|m|h|d|w|mo|y)\b/i.test(value)
    || /^\d+\s*(?:秒|分鐘|分钟|小時|小时|天|週|周|月|年|s|m|h|d|w|mo|y)$/i.test(value);
}

function normalizeThreadsPostUrl(raw: unknown): string {
  const value = String(raw || "").trim();
  const match = value.match(/^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[^/?#\s]+\/post\/[^/?#\s]+/i);
  if (!match) return "";
  return match[0].replace(/^https:\/\/www\.threads\.com\//i, "https://www.threads.net/");
}

function extractUniqueThreadsPostUrlsFromProfileLinks(links: string[], username: string): string[] {
  const normalizedUsername = String(username || "").replace(/^@+/, "").toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const link of links || []) {
    const normalized = normalizeThreadsPostUrl(link);
    if (!normalized) continue;
    if (!new RegExp(`/@${normalizedUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/post/`, "i").test(normalized)) continue;
    const code = normalized.match(/\/post\/([^/?#\s]+)/i)?.[1] || normalized;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(normalized);
  }
  return out;
}

function parseThreadsProfileMetricLines(lines: string[]): NonNullable<SentimentHotCandidate["engagement"]> {
  const numbers = lines
    .flatMap((line) => {
      const matches = Array.from(String(line || "").matchAll(/\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?/g));
      if (!matches.length) return [parseMetricNumberLoose(line)];
      return matches.map((match) => parseMetricNumberLoose(match[0]));
    })
    .filter((item): item is number => typeof item === "number" && item > 0)
    .slice(0, 8);
  const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {};
  if (typeof numbers[0] === "number") engagement.likeCount = numbers[0];
  if (typeof numbers[1] === "number") engagement.commentCount = numbers[1];
  if (typeof numbers[2] === "number") engagement.shareCount = numbers[2];
  if (numbers.length) engagement.rawSignals = numbers;
  return engagement;
}

function buildThreadsBrowserProfileSnapshot(args: {
  sourceUrl: string;
  engagement: NonNullable<SentimentHotCandidate["engagement"]>;
  metrics?: Record<string, unknown>;
}): ThreadsBrowserProfilePublishedPostSnapshot {
  const engagement: NonNullable<SentimentHotCandidate["engagement"]> = { ...(args.engagement || {}) };
  if (typeof engagement.likeCount !== "number") engagement.likeCount = 0;
  if (typeof engagement.commentCount !== "number") engagement.commentCount = 0;
  if (typeof engagement.shareCount !== "number") engagement.shareCount = 0;
  const rawSignals = engagement.rawSignals || [];
  const sendCount = rawSignals[3];
  const hotScore = Math.max(
    engagement.likeCount || 0,
    engagement.commentCount || 0,
    engagement.shareCount || 0,
    typeof sendCount === "number" ? sendCount : 0,
  );
  return {
    sourceUrl: args.sourceUrl,
    hotScore,
    engagement,
    metrics: {
      ...compactEngagementMetrics(engagement),
      ...(args.metrics || {}),
      repost_count: engagement.shareCount,
      send_count: sendCount,
    },
    capturedAt: new Date().toISOString(),
  };
}

export function parseThreadsBrowserProfilePublishedPosts(args: {
  username: string;
  text: string;
  links: string[];
}): Array<ThreadsBrowserProfilePublishedPostSnapshot & { content: string }> {
  const username = String(args.username || "").replace(/^@+/, "").trim();
  if (!username) return [];
  const postUrls = extractUniqueThreadsPostUrlsFromProfileLinks(args.links || [], username);
  const lines = String(args.text || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: Array<ThreadsBrowserProfilePublishedPostSnapshot & { content: string }> = [];
  let postIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].replace(/^@+/, "").toLowerCase() !== username.toLowerCase()) continue;
    const timeLine = lines[index + 1] || "";
    if (!isThreadsProfilePostTimeLine(timeLine)) continue;
    const contentLines: string[] = [];
    const metricLines: string[] = [];
    let cursor = index + 2;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const next = lines[cursor + 1] || "";
      if (line.replace(/^@+/, "").toLowerCase() === username.toLowerCase() && isThreadsProfilePostTimeLine(next)) break;
      if (/^(翻譯|翻译|translate|translation)$/i.test(line)) continue;
      const metric = parseMetricNumberLoose(line);
      if (typeof metric === "number" && metric > 0 && contentLines.length > 0) {
        metricLines.push(line);
        continue;
      }
      if (!metricLines.length) contentLines.push(line);
    }
    const content = contentLines.join("\n").trim();
    const sourceUrl = postUrls[postIndex++] || "";
    if (content && sourceUrl) {
      out.push({
        content,
        ...buildThreadsBrowserProfileSnapshot({
          sourceUrl,
          engagement: parseThreadsProfileMetricLines(metricLines),
        }),
      });
    }
    index = Math.max(index, cursor - 1);
  }
  return out;
}

export function matchThreadsBrowserProfilePublishedPost(args: {
  username: string;
  text: string;
  links: string[];
  content: string;
}): ThreadsBrowserProfilePublishedPostSnapshot | null {
  const target = normalizeThreadsPublishedHistoryText(args.content);
  if (!target) return null;
  const targetHead = target.slice(0, Math.min(24, target.length));
  const posts = parseThreadsBrowserProfilePublishedPosts({
    username: args.username,
    text: args.text,
    links: args.links,
  });
  let best: (ThreadsBrowserProfilePublishedPostSnapshot & { content: string }) | null = null;
  let bestScore = 0;
  for (const post of posts) {
    const current = normalizeThreadsPublishedHistoryText(post.content);
    if (!current) continue;
    let score = 0;
    if (targetHead && current.includes(targetHead)) score += 100;
    if (current && target.includes(current.slice(0, Math.min(18, current.length)))) score += 60;
    for (let len = Math.min(30, target.length, current.length); len >= 8; len -= 2) {
      if (current.includes(target.slice(0, len)) || target.includes(current.slice(0, len))) {
        score += len;
        break;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = post;
    }
  }
  if (!best || bestScore < 18) return null;
  const { content: _content, ...snapshot } = best;
  return snapshot;
}

async function readThreadsBrowserProfileMatchFromPage(args: {
  page: any;
  username: string;
  content: string;
}): Promise<ThreadsBrowserProfilePublishedPostSnapshot | null> {
  const profileText = await args.page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
  const links = await args.page.$$eval("a[href]", (items: any[]) => items
    .map((item: any) => item.href || item.getAttribute?.("href") || "")
    .filter(Boolean)).catch(() => []);
  return matchThreadsBrowserProfilePublishedPost({
    username: args.username,
    content: args.content,
    text: profileText,
    links,
  });
}

async function lookupThreadsPublishedPostFromBrowserSearchPage(args: {
  page: any;
  username: string;
  content: string;
}): Promise<ThreadsBrowserProfilePublishedPostSnapshot | null> {
  const username = String(args.username || "").replace(/^@+/, "").trim();
  const content = String(args.content || "").trim();
  if (!username || !content) return null;
  const queries = Array.from(new Set([
    content.replace(/\s+/g, " ").slice(0, 72),
    content.replace(/\s+/g, "").slice(0, 48),
    `${username} ${content.replace(/\s+/g, " ").slice(0, 48)}`,
  ].map((item) => item.trim()).filter((item) => item.length >= 6)));
  for (const query of queries.slice(0, 4)) {
    await args.page.goto(`https://www.threads.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    }).catch(() => null);
    await args.page.waitForTimeout(4500);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const matched = await readThreadsBrowserProfileMatchFromPage({
        page: args.page,
        username,
        content,
      });
      if (matched) return matched;
      await args.page.mouse.wheel(0, 1800).catch(() => null);
      await args.page.waitForTimeout(1200);
    }
  }
  return null;
}

function parseThreadsActionMetricText(value: unknown, labelPattern: RegExp): number | undefined {
  const text = String(value || "").replace(/\s+/g, "").trim();
  if (!labelPattern.test(text)) return undefined;
  const withoutLabel = text.replace(labelPattern, "");
  const count = parseMetricNumberLoose(withoutLabel);
  return typeof count === "number" ? count : 0;
}

function findThreadsActionMetricSequence(actionTexts: string[]) {
  const normalized = (actionTexts || []).map((item) => String(item || "").replace(/\s+/g, "").trim()).filter(Boolean);
  for (let index = 0; index <= normalized.length - 4; index += 1) {
    const like = parseThreadsActionMetricText(normalized[index], /^(?:Like|Likes|讚|赞|喜歡|喜欢)/i);
    const comment = parseThreadsActionMetricText(normalized[index + 1], /^(?:Comment|Comments|Reply|Replies|留言|回覆|回复|評論|评论)/i);
    const repost = parseThreadsActionMetricText(normalized[index + 2], /^(?:Repost|Reposts|轉發|转发)/i);
    const send = parseThreadsActionMetricText(normalized[index + 3], /^(?:Share|Shares|分享|傳送|发送|傳送給|发送给)/i);
    if ([like, comment, repost, send].every((item) => typeof item === "number")) {
      return { likeCount: like, commentCount: comment, repostCount: repost, sendCount: send };
    }
  }
  return null;
}

export function parseThreadsBrowserPostDetailMetrics(args: {
  text: string;
  actionTexts: string[];
}): Pick<ThreadsBrowserProfilePublishedPostSnapshot, "hotScore" | "engagement" | "metrics"> | null {
  const sequence = findThreadsActionMetricSequence(args.actionTexts || []);
  const text = String(args.text || "");
  const viewCount = parseMetricNumberLoose(
    text.match(/Thread\s+(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s+views/i)?.[1]
    || text.match(/串文\s*(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*次瀏覽/i)?.[1]
    || text.match(/(\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?)\s*次瀏覽/i)?.[1],
  );
  if (!sequence && typeof viewCount !== "number") return null;
  if (!sequence) {
    return {
      hotScore: viewCount as number,
      engagement: { viewCount },
      metrics: { view_count: viewCount as number },
    };
  }
  const rawSignals = [sequence.likeCount, sequence.commentCount, sequence.repostCount, sequence.sendCount]
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0);
  const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {
    likeCount: sequence.likeCount,
    commentCount: sequence.commentCount,
    shareCount: sequence.repostCount,
  };
  if (typeof viewCount === "number") engagement.viewCount = viewCount;
  if (rawSignals.length) engagement.rawSignals = rawSignals;
  const interactionHotScore = sequence.likeCount + sequence.commentCount + sequence.repostCount + sequence.sendCount;
  const hotScore = typeof viewCount === "number" ? viewCount : interactionHotScore;
  return {
    hotScore,
    engagement,
    metrics: {
      ...compactEngagementMetrics(engagement),
      repost_count: sequence.repostCount,
      send_count: sequence.sendCount,
    },
  };
}

async function readThreadsBrowserDetailMetricsFromPage(page: any, sourceUrl: string) {
  await page.goto(sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: 12_000,
  }).catch(() => null);
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /Thread\s+\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?\s+views/i.test(text)
      || /\d+(?:[.,]\d+)?\s*(?:[KkMm\u842c\u4e07])?\s*次瀏覽/i.test(text);
  }, undefined, { timeout: 4_500 }).catch(() => null);
  const detailText = await page.locator("body").innerText({ timeout: 6_000 }).catch(() => "");
  const actionTexts = await page.$$eval("[role=button],button", (items: any[]) => items
    .map((item) => (item.textContent || "").trim())
    .filter(Boolean)).catch(() => []);
  const detail = parseThreadsBrowserPostDetailMetrics({ text: detailText, actionTexts });
  if (typeof detail?.engagement?.viewCount === "number") return detail;
  const viewCount = await readThreadsPublicViewCountFallback(page, sourceUrl);
  if (typeof viewCount !== "number") return detail;
  return {
    ...(detail || { hotScore: 0, engagement: {}, metrics: {} }),
    hotScore: Math.max(Number(detail?.hotScore || 0), viewCount),
    engagement: { ...(detail?.engagement || {}), viewCount },
    metrics: { ...(detail?.metrics || {}), view_count: viewCount },
  };
}

export async function fetchThreadsBrowserDetailMetricsBatch(sourceUrls: string[], concurrency = 2, existingContext?: any) {
  if (process.env.VITEST_WORKER_ID) return null;
  const normalizedUrls = [...new Set(sourceUrls.map(normalizeThreadsPostUrl).filter(Boolean))];
  const results = new Map<string, Pick<ThreadsBrowserProfilePublishedPostSnapshot, "hotScore" | "engagement" | "metrics">>();
  if (!normalizedUrls.length) return results;
  const cookies = existingContext ? [] : readSentimentBrowserAuthCookies("threads");
  if (!existingContext && !cookies.length) return results;
  let browser: any = null;
  let context: any = existingContext || null;
  try {
    if (!context) {
      const playwright = await import("playwright");
      browser = await playwright.chromium.launch(buildLocalChromiumLaunchOptions());
      context = await browser.newContext({
        viewport: { width: 900, height: 1400 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      });
      await context.addCookies(cookies as any);
    }
    let cursor = 0;
    const workerCount = Math.min(
      boundedBrowserPageConcurrency(concurrency),
      normalizedUrls.length,
    );
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < normalizedUrls.length) {
        const sourceUrl = normalizedUrls[cursor];
        cursor += 1;
        const page = await context.newPage();
        try {
          const detail = await readThreadsBrowserDetailMetricsFromPage(page, sourceUrl);
          if (detail) results.set(sourceUrl, detail);
        } finally {
          await page.close().catch(() => null);
        }
      }
    }));
    return results;
  } catch {
    return results;
  } finally {
    if (!existingContext) await context?.close?.().catch?.(() => null);
    await browser?.close?.().catch?.(() => null);
  }
}

async function fetchThreadsBrowserDetailMetrics(sourceUrl: string): Promise<Pick<ThreadsBrowserProfilePublishedPostSnapshot, "hotScore" | "engagement" | "metrics"> | null> {
  const normalizedSourceUrl = normalizeThreadsPostUrl(sourceUrl);
  if (!normalizedSourceUrl) return null;
  const results = await fetchThreadsBrowserDetailMetricsBatch([normalizedSourceUrl], 1);
  return results?.get(normalizedSourceUrl) || null;
}

export async function lookupThreadsPublishedPostFromBrowserProfile(args: {
  username: string;
  content: string;
}): Promise<ThreadsBrowserProfilePublishedPostSnapshot | null> {
  const username = String(args.username || "").replace(/^@+/, "").trim();
  const content = String(args.content || "").trim();
  if (!username || !content) return null;
  const cookies = readSentimentBrowserAuthCookies("threads");
  if (!cookies.length) return null;
  let browser: any = null;
  try {
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch(buildLocalChromiumLaunchOptions());
    const context = await browser.newContext({
      viewport: { width: 900, height: 1400 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    await context.addCookies(cookies as any);
    const page = await context.newPage();
    await page.goto(buildThreadsProfileUrl(username), {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    }).catch(() => null);
    await page.waitForTimeout(4500);
    let matched = await readThreadsBrowserProfileMatchFromPage({ page, username, content });
    for (let attempt = 0; !matched && attempt < 8; attempt += 1) {
      await page.mouse.wheel(0, 2200).catch(() => null);
      await page.waitForTimeout(1400);
      matched = await readThreadsBrowserProfileMatchFromPage({ page, username, content });
    }
    if (!matched) {
      matched = await lookupThreadsPublishedPostFromBrowserSearchPage({ page, username, content });
    }
    if (!matched) return null;
    await page.goto(matched.sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    }).catch(() => null);
    await page.waitForTimeout(6500);
    const detailText = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    const actionTexts = await page.$$eval("[role=button],button", (items) => items
      .map((item) => (item.textContent || "").trim())
      .filter(Boolean)).catch(() => []);
    const detailMetrics = parseThreadsBrowserPostDetailMetrics({ text: detailText, actionTexts });
    if (!detailMetrics) return matched;
    return {
      ...matched,
      hotScore: detailMetrics.hotScore,
      engagement: detailMetrics.engagement,
      metrics: {
        ...(matched.metrics || {}),
        ...(detailMetrics.metrics || {}),
      },
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    await browser?.close?.().catch?.(() => null);
  }
}

function isNonPostThreadsMediaUrl(url: string): boolean {
  if (/profile_pic|s150x150|\/profile_pic_/i.test(url)) return true;
  if (/\/v\/t51\.\d+-19\//i.test(url)) return true;
  if (/\/favicon(?:[-_.]|\d|$)|favicon[_-]?\d*/i.test(url)) return true;
  if (/external-[^/]+\.xx\.fbcdn\.net\/emg1\/v\/t13\//i.test(url)) return true;
  return false;
}

function mediaAssetIdentity(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^data:/i.test(raw)) return raw;
  const base = raw.split("#")[0].split("?")[0];
  if (/^https?:\/\//i.test(raw)) {
    const file = (base.replace(/\/+$/, "").split("/").pop() || base).toLowerCase();
    return file.replace(/\.(?:png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i, "") || base.toLowerCase();
  }
  return base.replace(/\\/g, "/").toLowerCase();
}

function mediaAssetQuality(url: string): number {
  const text = String(url || "").toLowerCase();
  let score = 0;
  if (/\.(?:mp4|mov|webm)(?:$|[?#])|\/video/i.test(text)) score += 10_000;
  const dims = [...text.matchAll(/(?:^|[^\d])(\d{2,4})x(\d{2,4})(?:[^\d]|$)/g)];
  if (dims.length) {
    score += Math.min(Math.max(...dims.map((item) => Number(item[1]) * Number(item[2]))), 16_000_000) / 1000;
  } else {
    score += 2500;
  }
  if (/e35|s1080|p1080/.test(text)) score += 400;
  if (/s150x150|s320x320|s640x640|p150x150|p320x320/.test(text)) score -= 600;
  return score;
}

function isThreadsVideoMediaUrl(url: string): boolean {
  const text = String(url || "");
  if (/\.(?:mp4|mov|m4v|webm)(?:$|[?#])/i.test(text)) return true;
  if (/\/v\/t(?:50|42)\./i.test(text)) return true;
  if (/(?:^|\/\/)video[-.]/i.test(text)) return true;
  if (/\/o1\/v\/t\d+\//i.test(text)) return true;
  return false;
}

function isSameMediaAsset(left: string, right: string): boolean {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const leftId = mediaAssetIdentity(a);
  const rightId = mediaAssetIdentity(b);
  return Boolean(leftId && rightId && leftId === rightId);
}

function extractThreadsMediaFromMarkdown(text: string, limit = 12): SentimentHotMedia[] {
  const source = String(text || "");
  const media: SentimentHotMedia[] = [];
  let lastIndex = 0;
  for (const imageMatch of source.matchAll(/!\[([^\]]*)]\((https?:\/\/[^)\s]+)\)/g)) {
    const between = source.slice(lastIndex, imageMatch.index || 0);
    if (media.length > 0 && /Log in to see more replies|see more replies|more replies|回覆|回复|評論|评论/i.test(between)) break;
    lastIndex = (imageMatch.index || 0) + imageMatch[0].length;
    const alt = imageMatch[1] || "";
    const url = imageMatch[2];
    if (media.length > 0 && /profile picture/i.test(alt)) break;
    if (isNonPostThreadsMediaUrl(url)) continue;
    const existingIndex = media.findIndex((item) => isSameMediaAsset(item.url, url));
    if (existingIndex >= 0) {
      if (mediaAssetQuality(url) > mediaAssetQuality(media[existingIndex].url)) {
        media[existingIndex] = { ...media[existingIndex], url };
      }
      continue;
    }
    const type = isThreadsVideoMediaUrl(url) ? "video" : "image";
    media.push({ type, url });
    if (media.length >= limit) break;
  }
  if (!media.length) {
    for (const raw of source.matchAll(/https?:\/\/(?:scontent[^\s)"']+|cdninstagram\.com[^\s)"']+)/gi)) {
      const url = cleanText(raw[0]).replace(/[),.;]+$/, "");
      if (!url || isNonPostThreadsMediaUrl(url)) continue;
      const existingIndex = media.findIndex((item) => isSameMediaAsset(item.url, url));
      if (existingIndex >= 0) {
        if (mediaAssetQuality(url) > mediaAssetQuality(media[existingIndex].url)) {
          media[existingIndex] = { ...media[existingIndex], url };
        }
        continue;
      }
      media.push({ type: isThreadsVideoMediaUrl(url) ? "video" : "image", url });
      if (media.length >= limit) break;
    }
  }
  return media;
}

export function mergeCandidateMedia(base: SentimentHotMedia[], extra: SentimentHotMedia[]): SentimentHotMedia[] {
  const out: SentimentHotMedia[] = [];
  for (const item of [...base, ...extra]) {
    const url = String(item?.url || item?.localPath || "").trim();
    if (!url || isNonPostThreadsMediaUrl(url)) continue;
    const existingIndex = out.findIndex((existing) => (
      isSameMediaAsset(existing.url, item.url || url)
      || Boolean(item.localPath && existing.localPath && existing.localPath === item.localPath)
    ));
    if (existingIndex >= 0) {
      const current = out[existingIndex];
      const nextType = item.type === "video" || current.type === "video" || isThreadsVideoMediaUrl(url) ? "video" : (item.type || current.type);
      const nextUrl = nextType === "video" && current.type !== "video"
        ? url
        : (mediaAssetQuality(url) > mediaAssetQuality(current.url || current.localPath || "") ? url : current.url);
      const nextThumb = nextType === "video"
        ? (item.thumbnailUrl || current.thumbnailUrl || (current.type === "image" ? current.url : "") || (item.type === "image" ? url : ""))
        : (current.thumbnailUrl || item.thumbnailUrl);
      out[existingIndex] = {
        ...current,
        ...item,
        type: nextType,
        url: nextUrl,
        ...(nextThumb && nextThumb !== nextUrl ? { thumbnailUrl: nextThumb } : {}),
      };
      continue;
    }
    out.push(item);
    if (out.length >= 12) break;
  }
  return out;
}

export function parseThreadsDetailMediaMarkdown(text: string): SentimentHotMedia[] {
  return extractThreadsMediaFromMarkdown(text, 12);
}

async function fetchThreadsDetailData(sourceUrl: string): Promise<{
  engagement: NonNullable<SentimentHotCandidate["engagement"]>;
  media: SentimentHotMedia[];
}> {
  const normalizedSourceUrl = String(sourceUrl || "").replace(/^https:\/\/www\.threads\.com\//i, "https://www.threads.net/");
  if (!/^https:\/\/www\.threads\.net\/@[^/]+\/post\//i.test(normalizedSourceUrl)) return { engagement: {}, media: [] };
  try {
    const cacheBuster = `__r=${Date.now().toString(36)}`;
    const readerTargetUrl = `${normalizedSourceUrl}${normalizedSourceUrl.includes("?") ? "&" : "?"}${cacheBuster}`;
    const response = await fetchWithSharedPublicCrawlerLimit(readerTargetUrl, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "text/plain, text/markdown, */*",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    }, 12_000, "bypass");
    if (!response.ok) return { engagement: {}, media: [] };
    const text = await response.text();
    return {
      engagement: parseThreadsDetailEngagementMarkdown(text),
      media: parseThreadsDetailMediaMarkdown(text),
    };
  } catch {
    return { engagement: {}, media: [] };
  }
}

export async function refreshSentimentSourceMetrics(args: {
  platform?: string;
  sourceUrl: string;
  existingEngagement?: SentimentHotCandidate["engagement"];
  existingMedia?: SentimentHotMedia[];
  existingHotScore?: number;
}): Promise<{
  ok: boolean;
  message: string;
  hotScore?: number;
  metrics?: Record<string, unknown>;
  engagement?: NonNullable<SentimentHotCandidate["engagement"]>;
  media?: SentimentHotMedia[];
}> {
  const platform = String(args.platform || "").toLowerCase();
  const sourceUrl = String(args.sourceUrl || "").trim();
  if (!sourceUrl) return { ok: false, message: "缺少原帖链接，无法刷新热度。" };
  if (platform && platform !== "threads") {
    return { ok: false, message: "目前仅支持 Threads 原帖实时刷新热度。" };
  }
  const detail = await fetchThreadsDetailData(sourceUrl);
  const browserDetail = await fetchThreadsBrowserDetailMetrics(sourceUrl);
  const latestEngagement = browserDetail?.engagement || detail.engagement;
  const hasMetrics = hasNamedEngagementMetrics(latestEngagement);
  if (!hasMetrics && !detail.media.length) {
    return { ok: false, message: "暂时没有从原帖读取到新的热度数据，请稍后重试。" };
  }
  const engagement = refreshEngagementMetrics(args.existingEngagement || {}, latestEngagement);
  const media = mergeCandidateMedia(args.existingMedia || [], detail.media);
  const refreshedHotScore = realSentimentHotScore(engagement);
  const hotScore = typeof browserDetail?.hotScore === "number"
    ? browserDetail.hotScore
    : refreshedHotScore > 0
      ? refreshedHotScore
      : Number(args.existingHotScore || 0);
  return {
    ok: true,
    message: "已刷新原帖热度。",
    hotScore,
    engagement,
    media,
    metrics: {
      mediaCount: media.length,
      like_count: engagement.likeCount || 0,
      comment_count: engagement.commentCount || 0,
      share_count: engagement.shareCount || 0,
      repost_count: engagement.shareCount || 0,
      send_count: Number((browserDetail?.metrics as any)?.send_count || 0),
      ...(browserDetail?.metrics || {}),
      ...compactEngagementMetrics(engagement),
    },
  };
}

export async function enrichThreadsCandidateDetails(
  candidates: SentimentHotCandidate[],
  options: { force?: boolean; browserContext?: any; browserConcurrency?: number; includeReader?: boolean } = {},
): Promise<SentimentHotCandidate[]> {
  const targets = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => (
      candidate.platform === "threads"
      && /^https:\/\/(?:www\.)?threads\.(?:net|com)\/@[^/]+\/post\//i.test(candidate.sourceUrl)
      && (
        options.force === true
        || (
          typeof candidate.engagement?.viewCount !== "number"
          && typeof (candidate.metrics as any)?.view_count !== "number"
          && typeof (candidate.metrics as any)?.viewCount !== "number"
          && typeof (candidate.metrics as any)?.views !== "number"
        )
      )
    ))
    .slice(0, 10);
  if (!targets.length) return candidates;
  const enriched = [...candidates];
  const browserMetricsPromise = fetchThreadsBrowserDetailMetricsBatch(
    targets.map(({ candidate }) => candidate.sourceUrl),
    boundedBrowserPageConcurrency(options.browserConcurrency || 2),
    options.browserContext,
  );
  if (options.includeReader !== false) await Promise.all(targets.map(async ({ candidate, index }) => {
    const detail = await fetchThreadsDetailData(candidate.sourceUrl);
    if (!hasNamedEngagementMetrics(detail.engagement) && !detail.media.length) return;
    const engagement = mergeEngagementMetrics(candidate.engagement || {}, detail.engagement);
    if (options.force === true && typeof detail.engagement.viewCount === "number") {
      engagement.viewCount = detail.engagement.viewCount;
    }
    const media = mergeCandidateMedia(candidate.media || [], detail.media);
    enriched[index] = {
      ...candidate,
      hotScore: Math.max(candidate.hotScore, realSentimentHotScore(engagement)),
      media,
      engagement,
      metrics: {
        ...(candidate.metrics || {}),
        mediaCount: media.length,
        ...compactEngagementMetrics(engagement),
      },
    };
  }));
  const browserMetrics = await browserMetricsPromise;
  for (const { candidate, index } of targets) {
    const detail = browserMetrics?.get(normalizeThreadsPostUrl(candidate.sourceUrl));
    if (!detail) continue;
    const current = enriched[index];
    const engagement = mergeEngagementMetrics(current.engagement || {}, detail.engagement || {});
    if (typeof detail.engagement?.viewCount === "number") engagement.viewCount = detail.engagement.viewCount;
    const media = mergeCandidateMedia(current.media || [], (detail as any).media || []);
    enriched[index] = {
      ...current,
      hotScore: Math.max(current.hotScore, detail.hotScore, realSentimentHotScore(engagement)),
      media,
      engagement,
      metrics: {
        ...(current.metrics || {}),
        ...(detail.metrics || {}),
        mediaCount: media.length,
        ...compactEngagementMetrics(engagement),
      },
    };
  }
  return enriched;
}

function compactEngagementMetrics(engagement: NonNullable<SentimentHotCandidate["engagement"]>): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  if (typeof engagement.likeCount === "number") out.like_count = engagement.likeCount;
  if (typeof engagement.commentCount === "number") out.comment_count = engagement.commentCount;
  if (typeof engagement.viewCount === "number") out.view_count = engagement.viewCount;
  if (typeof engagement.shareCount === "number") out.share_count = engagement.shareCount;
  if (engagement.rawSignals?.length) out.raw_engagement_signals = engagement.rawSignals;
  return out;
}

function normalizeSentimentPublishedAt(value: unknown): string | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const yearRaw = Number(slash[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day)).toISOString();
    }
  }
  const isoDay = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoDay) {
    const year = Number(isoDay[1]);
    const month = Number(isoDay[2]);
    const day = Number(isoDay[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day)).toISOString();
    }
  }
  return normalizeThreadsRelativeTime(text);
}

export function parseThreadsReaderSearchMarkdownCandidates(args: {
  text: string;
  query: string;
  keywords?: string[];
  includeUnmatched?: boolean;
  limit?: number;
  sourceUrl: string;
}): SentimentHotCandidate[] {
  const text = String(args.text || "");
  if (!text || !/Search\s*•\s*Threads|Threads/i.test(text)) return [];
  const needleSource = [args.query, ...(args.keywords || [])].filter(Boolean);
  const needles = buildRelevanceNeedles(needleSource);
  const postRegex = /\[((?:\d{2}\/\d{2}\/\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d+(?:[.,]\d+)?(?:秒|分鐘|分钟|分|小時|小时|時|时|天|日|週|周|月|年|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|mos|y|yr|yrs)))\]\(((?:https?):\/\/(?:www\.)?threads\.(?:net|com)\/(?:@[^)\s]+\/post\/[^)\s]+|t\/[^)\s]+))\)\s*\n([\s\S]*?)(?=\n\[!\[Image\s+\d+:[^\]]*profile picture|\n\[[^\]\n]+]\((?:https?):\/\/(?:www\.)?threads\.(?:net|com)\/@|$)/g;
  const out: SentimentHotCandidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = postRegex.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 900), match.index);
    const authorMatches = [...before.matchAll(/\[([^\]\n]{2,80})]\(((?:https?):\/\/www\.threads\.(?:net|com)\/@[^)\s]+)\)/g)];
    const author = cleanText(authorMatches.at(-1)?.[1] || "Threads");
    const sourceUrl = match[2];
    const publishedAt = normalizeSentimentPublishedAt(match[1]);
    const block = match[3] || "";
    const content = cleanThreadsReaderContent(block);
    if (isLowQualitySentimentContent(content)) continue;
    if (!isChineseSentimentCandidate(content)) continue;
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0 && args.includeUnmatched !== true) continue;
    const engagement = extractEngagementMetricsFromText(block);
    const media = extractThreadsMediaFromMarkdown(block, 12);
    const id = buildSentimentCandidateId({ platform: "threads", sourceUrl, content });
    out.push({
      id,
      platform: "threads",
      sourceUrl,
      author,
      content,
      media,
      hotScore: realSentimentHotScore(engagement),
      metrics: {
        source: "threads-reader-search",
        query: args.query,
        matchedKeywords: matchedNeedles,
        mediaCount: media.length,
        publicSearch: true,
        crawler: "spider-markdown",
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      publishedAt,
      capturedAt: new Date().toISOString(),
      warnings: [],
    });
    if (out.length >= (args.limit || 10)) break;
  }

  // Threads' public search currently renders many results without a visible
  // date link. Reader serializes those cards as a profile link, post text and
  // a `/post/<shortcode>/media` link followed by engagement counters. Parse
  // that public shape as well; the shortcode supplies the original timestamp.
  const seenSourceUrls = new Set(out.map((candidate) => normalizeThreadsPostUrl(candidate.sourceUrl) || candidate.sourceUrl));
  const profileMarkers = [
    ...text.matchAll(/\[!\[[^\]]*(?:profile picture|头像|頭像)[^\]]*]\([^)]+\)]\((https?:\/\/www\.threads\.(?:net|com)\/@([^/)\s]+)\/?)[^)]*\)/gi),
    ...text.matchAll(/\[([^\]\n]{2,80})]\((https?:\/\/www\.threads\.(?:net|com)\/@([^/)\s]+)\/?)\)/g),
  ].map((item) => ({
    index: item.index || 0,
    end: (item.index || 0) + item[0].length,
    author: cleanText(item[2] || item[3] || item[1] || "Threads").replace(/^@/, ""),
  })).sort((left, right) => left.index - right.index);
  const postMatches = [...text.matchAll(/https?:\/\/www\.threads\.(?:net|com)\/@[^/)\s]+\/post\/[A-Za-z0-9_-]+(?:\/media)?/gi)];
  for (const postMatch of postMatches) {
    if (out.length >= (args.limit || 10)) break;
    const sourceUrl = normalizeThreadsPostUrl(postMatch[0]);
    if (!sourceUrl || seenSourceUrls.has(sourceUrl)) continue;
    const matchIndex = postMatch.index || 0;
    const markerIndex = profileMarkers.findLastIndex((marker) => marker.index < matchIndex);
    const marker = markerIndex >= 0 ? profileMarkers[markerIndex] : undefined;
    const nextMarker = markerIndex >= 0 ? profileMarkers[markerIndex + 1] : undefined;
    if (!marker || matchIndex - marker.end > 2_500) continue;
    const blockEnd = nextMarker?.index && nextMarker.index > matchIndex
      ? nextMarker.index
      : Math.min(text.length, matchIndex + 1_800);
    const block = text.slice(marker.end, blockEnd);
    const targetOffset = Math.max(0, matchIndex - marker.end);
    let contentBlock = block.slice(0, targetOffset);
    const mediaMarkupIndex = Math.max(contentBlock.lastIndexOf("\n[!["), contentBlock.lastIndexOf("[!["));
    if (mediaMarkupIndex >= 0) contentBlock = contentBlock.slice(0, mediaMarkupIndex);
    const content = cleanThreadsReaderContent(contentBlock);
    if (isLowQualitySentimentContent(content)) continue;
    if (!isChineseSentimentCandidate(content)) continue;
    const author = marker.author || "Threads";
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0 && args.includeUnmatched !== true) continue;
    const engagement = extractEngagementMetricsFromText(block);
    const media = extractThreadsMediaFromMarkdown(block, 12);
    const publishedAt = publishedAtFromThreadsShortcode(sourceUrl);
    const id = buildSentimentCandidateId({ platform: "threads", sourceUrl, content });
    out.push({
      id,
      platform: "threads",
      sourceUrl,
      author,
      content,
      media,
      hotScore: realSentimentHotScore(engagement),
      metrics: {
        source: "threads-reader-search",
        query: args.query,
        matchedKeywords: matchedNeedles,
        mediaCount: media.length,
        publicSearch: true,
        crawler: "spider-markdown",
        ...(publishedAt ? { publishedAtSource: "threads_shortcode_snowflake" } : {}),
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      ...(publishedAt ? { publishedAt } : {}),
      capturedAt: new Date().toISOString(),
      warnings: [],
    });
    seenSourceUrls.add(sourceUrl);
  }
  return out;
}

const INSTAGRAM_SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INSTAGRAM_SNOWFLAKE_EPOCH_MS = 1_314_220_021_721n;
const INSTAGRAM_SNOWFLAKE_TIMESTAMP_SHIFT = 23n;

/**
 * Instagram's public post shortcode embeds the media snowflake.  Decode only
 * the original creation timestamp from the canonical URL; never substitute
 * capture time when a public source omits a visible date.
 */
function publishedAtFromMetaShortcode(shortcode: string): string | undefined {
  if (!shortcode) return undefined;
  let mediaId = 0n;
  for (const character of shortcode) {
    const index = INSTAGRAM_SHORTCODE_ALPHABET.indexOf(character);
    if (index < 0) return undefined;
    mediaId = mediaId * 64n + BigInt(index);
  }
  const timestampMs = Number((mediaId >> INSTAGRAM_SNOWFLAKE_TIMESTAMP_SHIFT) + INSTAGRAM_SNOWFLAKE_EPOCH_MS);
  if (!Number.isSafeInteger(timestampMs)) return undefined;
  const earliestTimestampMs = Date.UTC(2010, 0, 1);
  if (timestampMs < earliestTimestampMs || timestampMs > Date.now() + 24 * 60 * 60 * 1000) return undefined;
  return new Date(timestampMs).toISOString();
}

function publishedAtFromInstagramShortcode(sourceUrl: string): string | undefined {
  const shortcode = String(sourceUrl || "").match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1];
  return publishedAtFromMetaShortcode(shortcode || "");
}

function publishedAtFromThreadsShortcode(sourceUrl: string): string | undefined {
  const shortcode = String(sourceUrl || "").match(/threads\.(?:net|com)\/@[^/]+\/post\/([A-Za-z0-9_-]+)/i)?.[1];
  return publishedAtFromMetaShortcode(shortcode || "");
}

function extractBalancedJsonObjectsAtMarker(value: string, marker: string, limit = 100): any[] {
  const source = String(value || "");
  const objects: any[] = [];
  let cursor = 0;
  while (objects.length < limit) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    cursor = end > start ? end : start + marker.length;
    if (end <= start) continue;
    try {
      objects.push(JSON.parse(source.slice(start, end)));
    } catch {
      // A malformed hydration fragment must not block the remaining nodes.
    }
  }
  return objects;
}

function instagramHydrationMetric(node: any, ...paths: string[]): number | undefined {
  for (const pathValue of paths) {
    let value = node;
    for (const key of pathValue.split(".")) value = value?.[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return undefined;
}

/**
 * Parse Instagram's public tag hydration emitted by Spider HTTP mode. This is
 * intentionally independent from a logged-in account and uses only values
 * attached to the same post node, preventing cross-card caption/metric joins.
 */
export function parseInstagramSpiderHydrationCandidates(args: {
  html: string;
  query: string;
  keywords?: string[];
  includeUnmatched?: boolean;
  limit?: number;
}): SentimentHotCandidate[] {
  const needles = buildRelevanceNeedles([args.query, ...(args.keywords || [])].filter(Boolean));
  const out: SentimentHotCandidate[] = [];
  const seenSourceUrls = new Set<string>();
  for (const wrapper of extractBalancedJsonObjectsAtMarker(args.html, '{"node":', 120)) {
    const node = wrapper?.node;
    const shortcode = cleanText(node?.code || node?.shortcode);
    if (!shortcode || !/^[A-Za-z0-9_-]+$/.test(shortcode)) continue;
    const content = cleanSentimentCandidateContent(node?.caption?.text || node?.caption || "");
    if (isLowQualitySentimentContent(content) || !isChineseSentimentCandidate(content)) continue;
    if ((content.match(/[\u3400-\u9fff]/gu) || []).length < 12) continue;
    const author = cleanText(node?.user?.username || node?.owner?.username || "Instagram");
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0 && args.includeUnmatched !== true) continue;
    const isVideo = node?.is_video === true || Number(node?.media_type) === 2 || cleanText(node?.product_type).toLowerCase() === "clips";
    const sourceUrl = `https://www.instagram.com/${isVideo ? "reel" : "p"}/${shortcode}/`;
    if (seenSourceUrls.has(sourceUrl)) continue;
    seenSourceUrls.add(sourceUrl);
    const engagement: NonNullable<SentimentHotCandidate["engagement"]> = {};
    const likeCount = instagramHydrationMetric(node, "like_count", "edge_media_preview_like.count", "edge_liked_by.count");
    const commentCount = instagramHydrationMetric(node, "comment_count", "edge_media_to_comment.count", "edge_media_to_parent_comment.count");
    const viewCount = instagramHydrationMetric(node, "play_count", "view_count", "video_view_count");
    if (typeof likeCount === "number") engagement.likeCount = likeCount;
    if (typeof commentCount === "number") engagement.commentCount = commentCount;
    if (typeof viewCount === "number") engagement.viewCount = viewCount;
    const publishedAt = publishedAtFromInstagramShortcode(sourceUrl);
    const mediaUrl = cleanText(node?.display_uri || node?.display_url || node?.thumbnail_src);
    const media: SentimentHotMedia[] = mediaUrl ? [{ type: "image", url: mediaUrl }] : [];
    const id = buildSentimentCandidateId({ platform: "instagram", sourceUrl, content });
    out.push({
      id,
      platform: "instagram",
      sourceUrl,
      author,
      content,
      media,
      hotScore: realSentimentHotScore(engagement),
      metrics: {
        source: "instagram-reader-search",
        crawler: "spider-http-hydration",
        publicSearch: true,
        query: args.query,
        matchedKeywords: matchedNeedles,
        mediaCount: media.length,
        ...(publishedAt ? { publishedAtSource: "instagram_shortcode_snowflake" } : {}),
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      ...(publishedAt ? { publishedAt } : {}),
      capturedAt: new Date().toISOString(),
      warnings: [],
    });
    if (out.length >= (args.limit || 10)) break;
  }
  return out;
}

export function parseInstagramReaderSearchMarkdownCandidates(args: {
  text: string;
  query: string;
  keywords?: string[];
  includeUnmatched?: boolean;
  limit?: number;
  sourceUrl: string;
}): SentimentHotCandidate[] {
  const text = String(args.text || "");
  if (!text || !/Instagram/i.test(text)) return [];
  const needleSource = [args.query, ...(args.keywords || [])].filter(Boolean);
  const needles = buildRelevanceNeedles(needleSource);
  const out: SentimentHotCandidate[] = [];
  // Reader serializes Instagram's canonical links as `http://` on public tag
  // pages even though the browser-facing URL is https.  Accept both forms so
  // those public results are not silently dropped before their shortcode can
  // supply the verifiable publish time.
  const postMatches = [...text.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/g)];
  const seenUrls = new Set<string>();
  for (const match of postMatches) {
    const sourceUrl = match[0].replace(/[)\].,]+$/g, "");
    if (seenUrls.has(sourceUrl)) continue;
    seenUrls.add(sourceUrl);
    const matchIndex = match.index || 0;
    const block = text.slice(Math.max(0, matchIndex - 900), Math.min(text.length, matchIndex + 1400));
    const authorMatches = [...block.matchAll(/\[([^\]\n@][^\]\n]{1,80})]\(https?:\/\/www\.instagram\.com\/([^/)#?]+)\/?\)/g)]
      .filter((item) => isLikelyInstagramAuthor(item[2]));
    const author = cleanText(authorMatches.at(-1)?.[1] || authorMatches.at(-1)?.[2] || "Instagram");
    const content = cleanThreadsReaderContent(block
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[[^\]]*(?:profile picture|Image|圖像|图片)[^\]]*]\([^)]*\)/gi, " ")
      .replace(/https?:\/\/(?:[^/\s]+\.)?(?:cdninstagram|scontent|fbcdn)[^\s)]+/gi, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[A-Za-z0-9_./?&=%:-]{60,}/g, " ")
      .replace(/https?:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/g, " ")
      .replace(/(?:Log in|Sign up|Explore|Search|Instagram)\s*/gi, " "));
    if (isLowQualitySentimentContent(content)) continue;
    if (!isChineseSentimentCandidate(content)) continue;
    if ((content.match(/[\u3400-\u9fff]/gu) || []).length < 12) continue;
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0 && args.includeUnmatched !== true) continue;
    const engagement = mergeEngagementMetrics(
      extractInstagramEngagementMetricsFromText(block),
      extractEngagementMetricsFromText(block),
    );
    const media = extractThreadsMediaFromMarkdown(block, 12);
    const publishedAt = publishedAtFromInstagramShortcode(sourceUrl);
    const id = buildSentimentCandidateId({ platform: "instagram", sourceUrl, content });
    out.push({
      id,
      platform: "instagram",
      sourceUrl,
      author,
      content,
      media,
      hotScore: realSentimentHotScore(engagement),
      metrics: {
        source: "instagram-reader-search",
        query: args.query,
        matchedKeywords: matchedNeedles,
        mediaCount: media.length,
        ...(publishedAt ? { publishedAtSource: "instagram_shortcode_snowflake" } : {}),
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      ...(publishedAt ? { publishedAt } : {}),
      capturedAt: new Date().toISOString(),
      warnings: [],
    });
    if (out.length >= (args.limit || 10)) break;
  }
  return out;
}

function isLikelyInstagramAuthor(value: string) {
  const text = cleanText(value).replace(/^@/, "");
  return Boolean(text && /^[A-Za-z0-9._]{2,30}$/.test(text) && !/^(?:p|reel|tv|explore|accounts|direct|stories|about|developer|legal|privacy)$/i.test(text));
}

const THREADS_SEARCH_CACHE_FILE = resolveRuntimeFile("sentiment_threads_search_cache.json");
const THREADS_SEARCH_CACHE_DIR = resolveRuntimeFile("sentiment_threads_search_cache");
const THREADS_SEARCH_CACHE_MIGRATION_MARKER = path.join(THREADS_SEARCH_CACHE_DIR, ".legacy-migrated");
const THREADS_SEARCH_CACHE_VERSION = 5;
const THREADS_SEARCH_CACHE_COMPATIBLE_VERSIONS = new Set([3, 4, THREADS_SEARCH_CACHE_VERSION]);
type ThreadsSearchCacheState = Record<string, { at: string; version?: number; candidates: SentimentHotCandidate[] }>;
const threadsSearchCacheSnapshots = new Map<string, { mtimeMs: number; size: number; state: ThreadsSearchCacheState }>();
let threadsSearchCacheMigrationChecked = false;

function isCompatibleThreadsSearchCacheRow(
  row: { at: string; version?: number; candidates: SentimentHotCandidate[] } | undefined,
  maxAgeMs = SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS,
): boolean {
  const at = Date.parse(String(row?.at || ""));
  return Boolean(
    row
    && THREADS_SEARCH_CACHE_COMPATIBLE_VERSIONS.has(Number(row.version || 0))
    && Array.isArray(row.candidates)
    && Number.isFinite(at)
    && Date.now() - at <= maxAgeMs,
  );
}

function threadsSearchArchiveCacheKeys(
  state: ReturnType<typeof readThreadsSearchCacheState>,
  archiveId: string,
  searchMode: SentimentHotSearchMode,
): string[] {
  const scopePrefix = `${cleanText(archiveId) || "default"}::`;
  const mode = normalizeSentimentHotSearchMode(searchMode);
  const modePrefix = `${scopePrefix}${mode}::`;
  const strictPrefix = `${scopePrefix}strict::`;
  return Object.keys(state).filter((key) => {
    if (key.startsWith(modePrefix)) return true;
    if (mode === "normal" && key.startsWith(strictPrefix)) return true;
    if (!key.startsWith(scopePrefix)) return false;
    const suffix = key.slice(scopePrefix.length);
    return !suffix.startsWith("normal::") && !suffix.startsWith("strict::");
  });
}

function threadsSearchStoredKeyword(key: string, archiveId: string): string {
  const scopePrefix = `${cleanText(archiveId) || "default"}::`;
  return cleanText(key.slice(scopePrefix.length).replace(/^(?:normal|strict)::/i, ""));
}

function compactThreadsSearchCacheState(state: ReturnType<typeof readThreadsSearchCacheState>): void {
  const keysByArchive = new Map<string, string[]>();
  for (const [key, row] of Object.entries(state)) {
    if (!isCompatibleThreadsSearchCacheRow(row, SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS)) {
      delete state[key];
      continue;
    }
    row.candidates = (row.candidates || []).slice(0, THREADS_SEARCH_CACHE_CANDIDATE_LIMIT);
    const archiveId = cleanText(key.split("::", 1)[0]);
    const keys = keysByArchive.get(archiveId) || [];
    keys.push(key);
    keysByArchive.set(archiveId, keys);
  }
  for (const keys of keysByArchive.values()) {
    keys
      .sort((a, b) => new Date(state[b]?.at || 0).getTime() - new Date(state[a]?.at || 0).getTime())
      .slice(THREADS_SEARCH_CACHE_MAX_ROWS_PER_ARCHIVE)
      .forEach((key) => delete state[key]);
  }
}

function threadsSearchCacheKeyScope(key: string): { archiveId: string; searchMode: SentimentHotSearchMode } {
  const parts = String(key || "").split("::");
  const archiveId = cleanText(parts[0]) || "default";
  return {
    archiveId,
    searchMode: parts[1] === "normal" ? "normal" : "strict",
  };
}

function threadsSearchCacheShardPath(archiveId: string, searchMode: SentimentHotSearchMode): string {
  const cleanArchiveId = cleanText(archiveId) || "default";
  const safeName = cleanArchiveId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "persona";
  const suffix = crypto.createHash("sha1").update(cleanArchiveId).digest("hex").slice(0, 10);
  return path.join(THREADS_SEARCH_CACHE_DIR, `${safeName}-${suffix}-${normalizeSentimentHotSearchMode(searchMode)}.json`);
}

function readThreadsSearchCacheFile(filePath: string, force = false): ThreadsSearchCacheState {
  try {
    if (!fs.existsSync(filePath)) return {};
    const stat = fs.statSync(filePath);
    const snapshot = threadsSearchCacheSnapshots.get(filePath);
    if (!force && snapshot && snapshot.mtimeMs === stat.mtimeMs && snapshot.size === stat.size) return snapshot.state;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const state = parsed && typeof parsed === "object" ? parsed as ThreadsSearchCacheState : {};
    threadsSearchCacheSnapshots.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
    return state;
  } catch {
    return {};
  }
}

function writeThreadsSearchCacheFile(filePath: string, state: ThreadsSearchCacheState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempFile, filePath);
  const stat = fs.statSync(filePath);
  threadsSearchCacheSnapshots.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
}

function migrateLegacyThreadsSearchCache(): void {
  if (threadsSearchCacheMigrationChecked) return;
  threadsSearchCacheMigrationChecked = true;
  try {
    fs.mkdirSync(THREADS_SEARCH_CACHE_DIR, { recursive: true });
    if (fs.existsSync(THREADS_SEARCH_CACHE_MIGRATION_MARKER) || !fs.existsSync(THREADS_SEARCH_CACHE_FILE)) return;
    const migrated = withExclusiveJsonFileLock(THREADS_SEARCH_CACHE_FILE, () => {
      if (fs.existsSync(THREADS_SEARCH_CACHE_MIGRATION_MARKER) || !fs.existsSync(THREADS_SEARCH_CACHE_FILE)) return;
      const legacyState = readThreadsSearchCacheFile(THREADS_SEARCH_CACHE_FILE, true);
      const shards = new Map<string, ThreadsSearchCacheState>();
      for (const [key, row] of Object.entries(legacyState)) {
        const scope = threadsSearchCacheKeyScope(key);
        const shardPath = threadsSearchCacheShardPath(scope.archiveId, scope.searchMode);
        const state = shards.get(shardPath) || {};
        state[key] = row;
        shards.set(shardPath, state);
      }
      for (const [shardPath, legacyShard] of shards) {
        const shardWritten = withExclusiveJsonFileLock(shardPath, () => {
          const state = structuredClone(readThreadsSearchCacheFile(shardPath, true));
          for (const [key, legacyRow] of Object.entries(legacyShard)) {
            const currentRow = state[key];
            if (!currentRow) {
              state[key] = legacyRow;
              continue;
            }
            const scope = threadsSearchCacheKeyScope(key);
            const byId = new Map<string, SentimentHotCandidate>();
            const byDedupeKey = new Set<string>();
            for (const candidate of [...(currentRow.candidates || []), ...(legacyRow.candidates || [])]) {
              if (!candidate?.id || byId.has(candidate.id)) continue;
              const dedupeKey = sentimentCandidateDedupeKey(candidate);
              if (byDedupeKey.has(dedupeKey)) continue;
              byId.set(candidate.id, candidate);
              byDedupeKey.add(dedupeKey);
            }
            const keyword = threadsSearchStoredKeyword(key, scope.archiveId);
            state[key] = {
              at: String(currentRow.at || "") >= String(legacyRow.at || "") ? currentRow.at : legacyRow.at,
              version: THREADS_SEARCH_CACHE_VERSION,
              candidates: sortSentimentHotCandidatePool(
                [...byId.values()],
                keyword ? [keyword] : [],
                THREADS_SEARCH_CACHE_CANDIDATE_LIMIT,
                scope.searchMode,
              ),
            };
          }
          compactThreadsSearchCacheState(state);
          writeThreadsSearchCacheFile(shardPath, state);
        });
        if (!shardWritten) throw new Error(`candidate cache shard migration lock timeout: ${path.basename(shardPath)}`);
      }
      fs.writeFileSync(THREADS_SEARCH_CACHE_MIGRATION_MARKER, new Date().toISOString(), "utf8");
      fs.renameSync(THREADS_SEARCH_CACHE_FILE, `${THREADS_SEARCH_CACHE_FILE}.migrated-${Date.now()}`);
      threadsSearchCacheSnapshots.delete(THREADS_SEARCH_CACHE_FILE);
    });
    if (!migrated) threadsSearchCacheMigrationChecked = false;
  } catch (error) {
    threadsSearchCacheMigrationChecked = false;
    throw error;
  }
}

function threadsSearchCacheKeys(archiveId: string, keywords: string[], searchMode: SentimentHotSearchMode = "strict"): string[] {
  const scope = cleanText(archiveId) || "default";
  const mode = normalizeSentimentHotSearchMode(searchMode);
  return buildThreadsSearchQueries(keywords)
    .slice(0, 8)
    .map((keyword) => `${scope}::${mode}::${keyword.toLowerCase()}`);
}

function readThreadsSearchCacheShardState(archiveId: string, searchMode: SentimentHotSearchMode, force = false): ThreadsSearchCacheState {
  migrateLegacyThreadsSearchCache();
  return readThreadsSearchCacheFile(threadsSearchCacheShardPath(archiveId, searchMode), force);
}

function readThreadsSearchCacheState(force = false, archiveId?: string, searchMode: SentimentHotSearchMode = "strict"): ThreadsSearchCacheState {
  migrateLegacyThreadsSearchCache();
  if (archiveId) {
    const mode = normalizeSentimentHotSearchMode(searchMode);
    const primary = readThreadsSearchCacheShardState(archiveId, mode, force);
    return mode === "normal"
      ? { ...readThreadsSearchCacheShardState(archiveId, "strict", force), ...primary }
      : primary;
  }
  const merged: ThreadsSearchCacheState = {};
  try {
    for (const entry of fs.readdirSync(THREADS_SEARCH_CACHE_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      Object.assign(merged, readThreadsSearchCacheFile(path.join(THREADS_SEARCH_CACHE_DIR, entry.name), force));
    }
  } catch {
    return merged;
  }
  return merged;
}

function writeThreadsSearchCandidateCache(archiveId: string, keywords: string[], candidates: SentimentHotCandidate[], searchMode: SentimentHotSearchMode = "strict") {
  const mode = normalizeSentimentHotSearchMode(searchMode);
  const qualifiedCandidates = candidates
    .filter((candidate) => !(candidate.metrics as any)?.globalPersonaBackfill)
    .map((candidate) => candidateMeetsDisplayQuality(candidate, keywords, mode, DEFAULT_REFRESH_FRESHNESS_DAYS))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate));
  const shardPath = threadsSearchCacheShardPath(archiveId, mode);
  migrateLegacyThreadsSearchCache();
  const written = withExclusiveJsonFileLock(shardPath, () => {
    const state = structuredClone(readThreadsSearchCacheFile(shardPath, true));
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const now = new Date().toISOString();
    // One indexed row is sufficient because reads scan the archive shard and
    // re-apply the current keyword and relevance gates. Avoid storing the same
    // candidate array once for every query keyword.
    for (const key of threadsSearchCacheKeys(archiveId, keywords, searchMode).slice(0, 1)) {
      const existingRow = state[key];
      const canReuseExisting = isCompatibleThreadsSearchCacheRow(existingRow, maxAgeMs);
      const byId = new Map<string, SentimentHotCandidate>();
      const byDedupeKey = new Set<string>();
      const add = (candidate: SentimentHotCandidate) => {
        if (!candidate?.id || byId.has(candidate.id)) return;
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (byDedupeKey.has(dedupeKey)) return;
        byId.set(candidate.id, candidate);
        byDedupeKey.add(dedupeKey);
      };
      for (const candidate of qualifiedCandidates) add(candidate);
      if (canReuseExisting) {
        for (const candidate of existingRow.candidates || []) {
          if ((candidate.metrics as any)?.globalPersonaBackfill) continue;
          const qualified = candidateMeetsDisplayQuality(candidate, keywords, mode, DEFAULT_REFRESH_FRESHNESS_DAYS);
          if (qualified) add(qualified);
        }
      }
      state[key] = {
        at: now,
        version: THREADS_SEARCH_CACHE_VERSION,
        candidates: sortSentimentHotCandidatePool([...byId.values()], keywords, THREADS_SEARCH_CACHE_CANDIDATE_LIMIT, searchMode)
          .map((candidate) => ({ ...candidate, warnings: uniqueSentimentWarnings(candidate.warnings || []) })),
      };
    }
    compactThreadsSearchCacheState(state);
    writeThreadsSearchCacheFile(shardPath, state);
  });
  if (!written) console.warn("[sentiment_hot_cache] candidate cache write skipped because the file is busy");
}

function readThreadsSearchCandidateCache(
  archiveId: string,
  keywords: string[],
  limit: number,
  excludeShown = false,
  searchMode: SentimentHotSearchMode = "strict",
  platform?: SentimentHotPlatform,
): SentimentHotCandidate[] {
  const state = readThreadsSearchCacheState(false, archiveId, searchMode);
  const excluded = excludeShown ? getSentimentHotRefreshExcludedIds(archiveId) : getSentimentHotExcludedIds(archiveId);
  const byId = new Map<string, SentimentHotCandidate>();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const primaryKeys = threadsSearchCacheKeys(archiveId, keywords, searchMode);
  const archiveKeys = threadsSearchArchiveCacheKeys(state, archiveId, searchMode)
    .filter((key) => !primaryKeys.includes(key))
    .sort((a, b) => new Date(state[b]?.at || 0).getTime() - new Date(state[a]?.at || 0).getTime());
  for (const key of [...primaryKeys, ...archiveKeys]) {
    const row = state[key];
    if (!isCompatibleThreadsSearchCacheRow(row, maxAgeMs)) continue;
    for (const candidate of row.candidates || []) {
      if (!candidate?.id || excluded.has(candidate.id) || (candidate.metrics as any)?.globalPersonaBackfill) continue;
      if (platform && !candidateMatchesRequestedPlatform(candidate, platform)) continue;
      const content = cleanThreadsReaderContent(candidate.content || "");
      const normalized = candidateMeetsDisplayQuality({
        ...candidate,
        content,
        warnings: uniqueSentimentWarnings([...(candidate.warnings || []), THREADS_SEARCH_CACHE_WARNING]),
      }, keywords, searchMode, DEFAULT_REFRESH_FRESHNESS_DAYS);
      if (!normalized) continue;
      byId.set(normalized.id, stampHotCandidateOrigin(normalized, "search_cache"));
    }
  }
  return sortSentimentHotCandidatePool([...byId.values()], keywords, limit, searchMode);
}

function isArchiveScopedFallbackCandidate(candidate: SentimentHotCandidate): boolean {
  return Boolean((candidate.metrics as any)?.archiveScopedFallback);
}

function isHistoricalSupplementCandidate(candidate: SentimentHotCandidate): boolean {
  const metrics = (candidate.metrics || {}) as any;
  return Boolean(metrics.archiveScopedFallback || metrics.globalPersonaBackfill || metrics.sourceTier === "fallback_history");
}

function readArchiveScopedThreadsCandidateBackfill(archiveId: string, keywords: string[], limit: number, excludeShown = false, searchMode: SentimentHotSearchMode = "strict"): SentimentHotCandidate[] {
  const state = readThreadsSearchCacheState(false, archiveId, searchMode);
  const excluded = excludeShown ? getSentimentHotRefreshExcludedIds(archiveId) : getSentimentHotExcludedIds(archiveId);
  const byId = new Map<string, SentimentHotCandidate>();
  const maxAgeMs = SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS;
  const archiveKeys = threadsSearchArchiveCacheKeys(state, archiveId, searchMode)
    .sort((a, b) => new Date(state[b]?.at || 0).getTime() - new Date(state[a]?.at || 0).getTime());
  for (const key of archiveKeys) {
    const row = state[key];
    if (!isCompatibleThreadsSearchCacheRow(row, maxAgeMs)) continue;
    const storedKeyword = threadsSearchStoredKeyword(key, archiveId);
    if (!storedKeyword) continue;
    for (const candidate of row.candidates || []) {
      if (!candidate?.id || excluded.has(candidate.id) || byId.has(candidate.id) || (candidate.metrics as any)?.globalPersonaBackfill) continue;
      const content = cleanThreadsReaderContent(candidate.content || "");
      const normalized = candidateMeetsDisplayQuality({
        ...candidate,
        content,
        metrics: {
          ...(candidate.metrics || {}),
          archiveScopedFallback: true,
          archiveScopedKeyword: storedKeyword,
          origin: "candidate_pool",
          liveFetch: false,
        },
      }, keywords, searchMode, DEFAULT_REFRESH_FRESHNESS_DAYS);
      if (!normalized) continue;
      byId.set(normalized.id, {
        ...normalized,
        warnings: uniqueSentimentWarnings([
          ...(candidate.warnings || []),
          "即時新候選不足，已使用同一人設歷史關鍵詞候選回補。",
        ]),
      });
      if (byId.size >= limit) break;
    }
    if (byId.size >= limit) break;
  }
  return sortSentimentHotCandidatePool([...byId.values()], keywords, limit, searchMode);
}

export type SentimentHotCandidatePoolStat = {
  archiveId: string;
  searchMode: SentimentHotSearchMode;
  readyCount: number;
  newestAt: string;
  strategyReady: boolean;
};

export function getSentimentHotGlobalPoolStat(): { readyCount: number; newestAt: string } {
  let db: any = null;
  try {
    db = openSentimentHotGlobalPoolDatabase();
    const row = db.prepare(`
      SELECT COUNT(*) AS ready_count, MAX(captured_at_ms) AS newest_at_ms
      FROM sentiment_hot_global_candidates
      WHERE content_at_ms >= ?
    `).get(Date.now() - SENTIMENT_HOT_GLOBAL_POOL_RETENTION_MS) as any;
    return {
      readyCount: Number(row?.ready_count || 0),
      newestAt: Number(row?.newest_at_ms || 0) > 0 ? new Date(Number(row.newest_at_ms)).toISOString() : "",
    };
  } catch (error) {
    console.warn(`[sentiment_hot_global_pool] stat fallback=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    const candidates = readLegacyGlobalSentimentHotCandidatePool();
    return {
      readyCount: candidates.length,
      newestAt: candidates.reduce((latest, candidate) => (
        String(candidate.capturedAt || "") > latest ? String(candidate.capturedAt || "") : latest
      ), ""),
    };
  } finally {
    db?.close?.();
  }
}

function readGlobalThreadsCandidateBackfill(
  archiveId: string,
  keywords: string[],
  limit: number,
  searchMode: SentimentHotSearchMode,
  platform?: SentimentHotPlatform,
): SentimentHotCandidate[] {
  const excluded = getSentimentHotExcludedIds(archiveId);
  const byId = new Map<string, SentimentHotCandidate>();
  const candidateTarget = Math.max(limit * 3, 120);
  const scanLimit = Math.max(limit * 200, 8_000);
  const quickNeedles = meaningfulNeedles(keywords).map((term) => term.toLowerCase()).filter(Boolean);
  let scanned = 0;
  const rows = readGlobalSentimentHotCandidatePool(scanLimit, quickNeedles, platform);
  for (const candidate of rows) {
    scanned += 1;
    if (scanned > scanLimit || byId.size >= candidateTarget) break;
    if (!candidate?.id || excluded.has(candidate.id) || byId.has(candidate.id)) continue;
    const quickHaystack = `${candidate.content || ""} ${candidate.author || ""}`.toLowerCase();
    if (quickNeedles.length > 0 && !quickNeedles.some((term) => quickHaystack.includes(term))) continue;
    const metrics = { ...(candidate.metrics || {}) } as Record<string, unknown>;
    delete metrics.semanticRelevant;
    delete metrics.semanticRelevanceScope;
    delete metrics.semanticContentHash;
    const content = cleanThreadsReaderContent(candidate.content || "");
    const normalized = candidateMeetsDisplayQuality({
      ...candidate,
      content,
      metrics: { ...metrics, archiveScopedFallback: true, globalPersonaBackfill: true },
    }, keywords, searchMode);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return sortSentimentHotCandidatePool([...byId.values()], keywords, limit, searchMode);
}

function normalizeSentimentHotGlobalPoolCandidate(candidate: SentimentHotCandidate): SentimentHotCandidate | null {
  if (!candidate?.id) return null;
  const metrics = { ...(candidate.metrics || {}) } as Record<string, unknown>;
  delete metrics.semanticRelevant;
  delete metrics.semanticRelevanceScope;
  delete metrics.semanticContentHash;
  delete metrics.archiveScopedFallback;
  delete metrics.globalPersonaBackfill;
  const normalized = candidateMeetsDisplayQuality({ ...candidate, metrics }, [], "normal", DEFAULT_REFRESH_FRESHNESS_DAYS);
  if (!normalized) return null;
  if (!candidateMatchesGlobalPoolRetention(normalized)) return null;
  return normalized;
}

function readLegacyGlobalSentimentHotCandidatePool(): SentimentHotCandidate[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(SENTIMENT_HOT_GLOBAL_POOL_FILE, "utf8"));
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return candidates
      .map((candidate: SentimentHotCandidate) => normalizeSentimentHotGlobalPoolCandidate(candidate))
      .filter((candidate: SentimentHotCandidate | null): candidate is SentimentHotCandidate => Boolean(candidate))
      .sort(compareSentimentHotPriority)
      .slice(0, SENTIMENT_HOT_GLOBAL_POOL_LIMIT);
  } catch {
    return [];
  }
}

const SENTIMENT_HOT_GLOBAL_POOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS sentiment_hot_global_candidates (
  id TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  hot_score REAL NOT NULL,
  content_at_ms INTEGER NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'threads'
);
CREATE INDEX IF NOT EXISTS idx_sentiment_hot_global_content_at
  ON sentiment_hot_global_candidates(content_at_ms DESC, hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_hot_global_hot_score
  ON sentiment_hot_global_candidates(hot_score DESC, content_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_hot_global_platform
  ON sentiment_hot_global_candidates(platform, content_at_ms DESC, hot_score DESC);
CREATE TABLE IF NOT EXISTS sentiment_hot_global_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function upsertSentimentHotGlobalPoolRows(db: any, candidates: SentimentHotCandidate[]): number {
  const acceptedById = new Map<string, SentimentHotCandidate>();
  for (const candidate of candidates) {
    const normalized = normalizeSentimentHotGlobalPoolCandidate(candidate);
    if (normalized) acceptedById.set(normalized.id, normalized);
  }
  if (acceptedById.size === 0) return 0;
  const statement = db.prepare(`
    INSERT INTO sentiment_hot_global_candidates
      (id, candidate_json, search_text, hot_score, content_at_ms, captured_at_ms, updated_at_ms, platform)
    VALUES
      (@id, @candidateJson, @searchText, @hotScore, @contentAtMs, @capturedAtMs, @updatedAtMs, @platform)
    ON CONFLICT(id) DO UPDATE SET
      candidate_json=excluded.candidate_json,
      search_text=excluded.search_text,
      hot_score=excluded.hot_score,
      content_at_ms=excluded.content_at_ms,
      captured_at_ms=excluded.captured_at_ms,
      updated_at_ms=excluded.updated_at_ms,
      platform=excluded.platform
  `);
  const now = Date.now();
  const write = db.transaction((rows: SentimentHotCandidate[]) => {
    for (const candidate of rows) {
      statement.run({
        id: candidate.id,
        candidateJson: JSON.stringify(candidate),
        searchText: `${candidate.content || ""} ${candidate.author || ""}`.toLowerCase(),
        hotScore: Number(candidate.hotScore || 0),
        contentAtMs: sentimentHotPublishedAtMs(candidate),
        capturedAtMs: Date.parse(candidate.capturedAt || "") || now,
        updatedAtMs: now,
        platform: normalizeRequestedHotPlatform(candidate.platform) ?? "threads",
      });
    }
  });
  write([...acceptedById.values()]);
  return acceptedById.size;
}

function openSentimentHotGlobalPoolDatabase(): any {
  fs.mkdirSync(path.dirname(SENTIMENT_HOT_GLOBAL_POOL_DB_FILE), { recursive: true });
  const db = new Database(path.resolve(SENTIMENT_HOT_GLOBAL_POOL_DB_FILE));
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SENTIMENT_HOT_GLOBAL_POOL_SCHEMA);
  const columns = (db.prepare("PRAGMA table_info(sentiment_hot_global_candidates)").all() as Array<{ name?: string }>)
    .map((row) => String(row?.name || ""));
  if (!columns.includes("platform")) {
    db.exec("ALTER TABLE sentiment_hot_global_candidates ADD COLUMN platform TEXT NOT NULL DEFAULT 'threads'");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_sentiment_hot_global_platform ON sentiment_hot_global_candidates(platform, content_at_ms DESC, hot_score DESC)");
  const platformBackfilled = db.prepare("SELECT value FROM sentiment_hot_global_meta WHERE key='platform_column_backfilled'").get();
  if (!platformBackfilled) {
    db.exec(`
      UPDATE sentiment_hot_global_candidates
      SET platform = lower(coalesce(json_extract(candidate_json, '$.platform'), platform, 'threads'))
      WHERE json_extract(candidate_json, '$.platform') IN ('threads', 'instagram')
    `);
    db.prepare("INSERT OR REPLACE INTO sentiment_hot_global_meta(key,value) VALUES('platform_column_backfilled',?)")
      .run(new Date().toISOString());
  }
  const migrated = db.prepare("SELECT value FROM sentiment_hot_global_meta WHERE key='legacy_json_migrated'").get();
  if (!migrated) {
    upsertSentimentHotGlobalPoolRows(db, readLegacyGlobalSentimentHotCandidatePool());
    db.prepare("INSERT OR REPLACE INTO sentiment_hot_global_meta(key,value) VALUES('legacy_json_migrated',?)")
      .run(new Date().toISOString());
  }
  return db;
}

function readGlobalSentimentHotCandidatePool(
  limit = SENTIMENT_HOT_GLOBAL_POOL_LIMIT,
  quickNeedles: string[] = [],
  platform?: SentimentHotPlatform,
): SentimentHotCandidate[] {
  let db: any = null;
  try {
    db = openSentimentHotGlobalPoolDatabase();
    const cutoff = Date.now() - SENTIMENT_HOT_GLOBAL_POOL_RETENTION_MS;
    db.prepare("DELETE FROM sentiment_hot_global_candidates WHERE content_at_ms < ?").run(cutoff);
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit || 1), SENTIMENT_HOT_GLOBAL_POOL_LIMIT));
    const terms = [...new Set(quickNeedles.map(cleanText).filter((term) => term.length >= 2))].slice(0, 12);
    const requestedPlatform = normalizeRequestedHotPlatform(platform);
    const whereTerms = terms.length > 0 ? ` AND (${terms.map(() => "search_text LIKE ?").join(" OR ")})` : "";
    const wherePlatform = requestedPlatform ? " AND platform = ?" : "";
    const rows = db.prepare(`
      SELECT candidate_json FROM sentiment_hot_global_candidates
      WHERE content_at_ms >= ?${wherePlatform}${whereTerms}
      ORDER BY content_at_ms DESC, hot_score DESC
      LIMIT ?
    `).all(
      cutoff,
      ...(requestedPlatform ? [requestedPlatform] : []),
      ...terms.map((term) => `%${term.toLowerCase()}%`),
      boundedLimit,
    ) as Array<{ candidate_json: string }>;
    return rows.flatMap((row) => {
      try {
        const candidate = JSON.parse(row.candidate_json) as SentimentHotCandidate;
        if (!candidate?.id) return [];
        if (requestedPlatform && !candidateMatchesRequestedPlatform(candidate, requestedPlatform)) return [];
        return [candidate];
      } catch {
        return [];
      }
    });
  } catch (error) {
    console.warn(`[sentiment_hot_global_pool] read fallback=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    const rows = readLegacyGlobalSentimentHotCandidatePool().filter((candidate) => (
      !platform || candidateMatchesRequestedPlatform(candidate, normalizeRequestedHotPlatform(platform))
    ));
    if (quickNeedles.length === 0) return rows.slice(0, limit);
    return rows.filter((candidate) => {
      const haystack = `${candidate.content || ""} ${candidate.author || ""}`.toLowerCase();
      return quickNeedles.some((term) => haystack.includes(term.toLowerCase()));
    }).slice(0, limit);
  } finally {
    db?.close?.();
  }
}

export function recycleUnusedSentimentHotCandidates(args: {
  archiveId: string;
  candidates: SentimentHotCandidate[];
  searchMode?: SentimentHotSearchMode;
}): { recycled: number } {
  const archiveId = cleanText(args.archiveId);
  const candidates = (args.candidates || []).filter((item) => item?.id && cleanSentimentCandidateContent(item.content));
  if (!archiveId || !candidates.length) return { recycled: 0 };
  const searchMode = normalizeSentimentHotSearchMode(args.searchMode);
  const keywords = [...new Set(candidates.flatMap((item) => {
    const query = cleanText((item.metrics as any)?.query);
    const matched = Array.isArray((item.metrics as any)?.matchedKeywords) ? (item.metrics as any).matchedKeywords : [];
    return [query, ...matched.map(cleanText)].filter(Boolean);
  }))];
  writeGlobalSentimentHotCandidatePool(candidates);
  if (keywords.length) writeThreadsSearchCandidateCache(archiveId, keywords, candidates, searchMode);
  forgetSentimentHotShown(archiveId, candidates.map((item) => item.id));
  return { recycled: candidates.length };
}

export function writeGlobalSentimentHotCandidatePool(candidates: SentimentHotCandidate[]): void {
  let db: any = null;
  try {
    db = openSentimentHotGlobalPoolDatabase();
    const cutoff = Date.now() - SENTIMENT_HOT_GLOBAL_POOL_RETENTION_MS;
    db.prepare("DELETE FROM sentiment_hot_global_candidates WHERE content_at_ms < ?").run(cutoff);
    const inserted = upsertSentimentHotGlobalPoolRows(db, candidates);
    if (inserted === 0) return;
  } catch (error) {
    console.warn(`[sentiment_hot_global_pool] write failed=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
  } finally {
    db?.close?.();
  }
}

export function listSentimentHotCandidatePoolStats(archives: PersonaArchive[] = []): SentimentHotCandidatePoolStat[] {
  const fallbackState = archives.length > 0 ? {} : readThreadsSearchCacheState();
  const archiveById = new Map(archives.map((archive) => [cleanText(archive.id), archive]));
  const archiveIds = [...new Set([
    ...archiveById.keys(),
    ...Object.keys(fallbackState)
    .map((key) => cleanText(key.split("::", 1)[0]))
    .filter(Boolean),
  ])];
  const stats: SentimentHotCandidatePoolStat[] = [];
  for (const archiveId of archiveIds) {
    const archive = archiveById.get(archiveId);
    const strategy = archive ? readCachedSentimentHotSearchStrategyForArgs({
      archive,
    }) : null;
    if (strategy && archive) {
      applyPersonaGuardToSentimentHotStrategy({ strategy });
    }
    for (const searchMode of ["normal", "strict"] as const) {
      const state = readThreadsSearchCacheState(false, archiveId, searchMode);
      const keywords = resolveSentimentHotModelStrategyKeywords(strategy, searchMode);
      const cachedCandidates = keywords.length > 0
        ? readThreadsSearchCandidateCache(
            archiveId,
            keywords,
            SENTIMENT_HOT_CANDIDATE_POOL_TARGET,
            true,
            searchMode,
          )
        : [];
      const anchoredCandidates = strategy
        ? cachedCandidates.filter((candidate) => candidateMatchesStrategyOrVerifiedFreshFallback(candidate, strategy, searchMode))
        : cachedCandidates;
      const readyCandidates = finalizeSentimentHotCandidatesForDisplay(
        anchoredCandidates,
        SENTIMENT_HOT_CANDIDATE_POOL_TARGET,
        { archiveId, keywords, excludeShown: true, searchMode },
      );
      let newestAt = "";
      for (const key of threadsSearchArchiveCacheKeys(state, archiveId, searchMode)) {
        const row = state[key];
        if (!isCompatibleThreadsSearchCacheRow(row, 24 * 60 * 60 * 1000)) continue;
        if (String(row.at || "") > newestAt) newestAt = String(row.at || "");
      }
      stats.push({
        archiveId,
        searchMode,
        readyCount: readyCandidates.length,
        newestAt,
        strategyReady: Boolean(strategy),
      });
    }
  }
  return stats;
}

function mergeBrowserAuthCookies(...groups: any[][]): any[] {
  const byKey = new Map<string, any>();
  for (const cookie of groups.flat()) {
    if (!cookie?.name || !cookie?.value || !cookie?.domain) continue;
    const key = [cookie.name, String(cookie.domain).toLowerCase(), cookie.path || "/"].join("|");
    if (!byKey.has(key)) byKey.set(key, cookie);
  }
  return [...byKey.values()];
}

function readPlatformCookiesFromProfileDir(profileDir: unknown, platform: "threads" | "instagram"): any[] {
  const cookieDbPath = path.join(cleanText(profileDir), "cookies.sqlite");
  if (!fs.existsSync(cookieDbPath)) return [];
  let cookieDb: any = null;
  try {
    cookieDb = new Database(cookieDbPath, { readonly: true, fileMustExist: true });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const hostPattern = platform === "instagram" ? "%instagram.%" : "%threads.%";
    const rows = cookieDb.prepare(`
      SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
      FROM moz_cookies
      WHERE lower(host) LIKE ?
        AND (expiry = 0 OR expiry > ?)
    `).all(hostPattern, nowSeconds);
    return rows.map((row: any) => ({
      name: String(row.name || ""),
      value: String(row.value || ""),
      domain: String(row.host || ""),
      path: String(row.path || "/"),
      expires: normalizeSentimentBrowserCookieExpiry(row.expiry),
      httpOnly: Boolean(row.isHttpOnly),
      secure: Boolean(row.isSecure),
      sameSite: Number(row.sameSite) === 2 ? "Strict" : Number(row.sameSite) === 1 ? "Lax" : "None",
    }));
  } catch {
    return [];
  } finally {
    cookieDb?.close?.();
  }
}

function readThreadsCookiesFromProfileDir(profileDir: unknown): any[] {
  return readPlatformCookiesFromProfileDir(profileDir, "threads");
}

function readInstagramCookiesFromProfileDir(profileDir: unknown): any[] {
  return readPlatformCookiesFromProfileDir(profileDir, "instagram");
}

function readManagedThreadsAccountCookies(): any[] {
  const preferredProfileDir = cleanText(process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR || process.env.THREADS_AUTH_PROFILE_DIR);
  if (preferredProfileDir) {
    const preferredCookies = readThreadsCookiesFromProfileDir(preferredProfileDir);
    if (hasValidThreadsSessionCookie(preferredCookies)) return preferredCookies;
  }
  if (/^(?:1|true|yes|on)$/i.test(cleanText(process.env.TG_COLLECTOR_PROFILE_REQUIRED))) {
    return [];
  }
  const dataDirs = [
    cleanText(process.env.WEBAPP_DATA_DIR),
    "/data/webapp_data",
    path.resolve(process.cwd(), "webapp_data"),
    path.resolve(process.cwd(), "..", "webapp_data"),
  ].filter(Boolean);
  let bestCookies: any[] = [];
  let bestCookieScore = -1;
  for (const dataDir of [...new Set(dataDirs)]) {
    const appDbPath = path.join(dataDir, "app.db");
    if (!fs.existsSync(appDbPath)) continue;
    let appDb: any = null;
    try {
      appDb = new Database(appDbPath, { readonly: true, fileMustExist: true });
      const accounts = appDb.prepare(`
        SELECT profile_dir
        FROM social_accounts
        WHERE lower(platform) = 'threads'
          AND lower(status) IN ('ready', 'active')
          AND trim(profile_dir) <> ''
        ORDER BY last_login_check_at DESC, updated_at DESC
        LIMIT 8
      `).all();
      for (const account of accounts) {
        const cookies = readThreadsCookiesFromProfileDir(account?.profile_dir);
        if (hasValidThreadsSessionCookie(cookies)) {
          const cookieNames = new Set(cookies.map((cookie: any) => cleanText(cookie?.name).toLowerCase()).filter(Boolean));
          const cookieScore = cookieNames.size * 10 + cookies.length;
          if (cookieScore > bestCookieScore) {
            bestCookies = cookies;
            bestCookieScore = cookieScore;
          }
        }
      }
    } catch {
      // Account-managed browser profiles are optional outside the web runtime.
    } finally {
      appDb?.close?.();
    }
  }
  return bestCookies;
}

function readManagedInstagramAccountCookies(): any[] {
  const preferredProfileDir = cleanText(process.env.PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR || process.env.INSTAGRAM_AUTH_PROFILE_DIR);
  if (preferredProfileDir) {
    const preferredCookies = readInstagramCookiesFromProfileDir(preferredProfileDir);
    if (hasValidInstagramSessionCookie(preferredCookies)) return preferredCookies;
  }
  if (/^(?:1|true|yes|on)$/i.test(cleanText(process.env.TG_COLLECTOR_PROFILE_REQUIRED))) {
    return [];
  }
  const dataDirs = [
    cleanText(process.env.WEBAPP_DATA_DIR),
    "/data/webapp_data",
    path.resolve(process.cwd(), "webapp_data"),
    path.resolve(process.cwd(), "..", "webapp_data"),
  ].filter(Boolean);
  for (const dataDir of [...new Set(dataDirs)]) {
    const appDbPath = path.join(dataDir, "app.db");
    if (!fs.existsSync(appDbPath)) continue;
    let appDb: any = null;
    try {
      appDb = new Database(appDbPath, { readonly: true, fileMustExist: true });
      const accounts = appDb.prepare(`
        SELECT profile_dir
        FROM social_accounts
        WHERE lower(platform) = 'instagram'
          AND lower(status) IN ('ready', 'active')
          AND trim(profile_dir) <> ''
        ORDER BY last_login_check_at DESC, updated_at DESC
        LIMIT 8
      `).all();
      for (const account of accounts) {
        const cookies = readInstagramCookiesFromProfileDir(account?.profile_dir);
        if (hasValidInstagramSessionCookie(cookies)) return cookies;
      }
    } catch {
      // Account-managed browser profiles are optional outside the web runtime.
    } finally {
      appDb?.close?.();
    }
  }
  return [];
}

function expandThreadsAuthCookiesForBrowser(cookies: any[]): any[] {
  const mirrored = cookies
    .filter((cookie: any) => cookieDomainMatchesAny(cookie, ["threads.net", "threads.com"]))
    .flatMap((cookie: any) => [
      { ...cookie, domain: ".threads.net" },
      { ...cookie, domain: ".threads.com" },
    ]);
  return mergeBrowserAuthCookies(cookies, mirrored).slice(0, 120);
}

function readSentimentBrowserAuthCookies(platform: SentimentHotPlatform) {
  try {
    const collectorProfileRequired = /^(?:1|true|yes|on)$/i.test(cleanText(process.env.TG_COLLECTOR_PROFILE_REQUIRED));
    const profile = readSentimentBrowserAuthProfilesConfig().find((item: any) => sentimentProfileMatchesPlatform(item, platform));
    const nowSeconds = Date.now() / 1000;
    const cookies = (Array.isArray(profile?.cookies) ? profile.cookies : [])
      .filter((cookie: any) => {
        const expires = normalizeSentimentBrowserCookieExpiry(cookie?.expires);
        return cookie?.name && cookie?.value && (!Number.isFinite(expires) || expires <= 0 || expires > nowSeconds);
      })
      .map((cookie: any) => {
        const sameSite = ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined;
        return {
          name: String(cookie.name),
          value: String(cookie.value),
          domain: String(cookie.domain || profile.domain || "threads.net"),
          path: String(cookie.path || "/"),
          expires: normalizeSentimentBrowserCookieExpiry(cookie.expires),
          httpOnly: Boolean(cookie.httpOnly || cookie.http_only),
          secure: cookie.secure !== false,
          sameSite,
        };
      });
    if (platform === "instagram") {
      const managedCookies = readManagedInstagramAccountCookies();
      if (collectorProfileRequired) return managedCookies.slice(0, 120);
      return hasValidInstagramSessionCookie(managedCookies)
        ? mergeBrowserAuthCookies(managedCookies, cookies).slice(0, 120)
        : mergeBrowserAuthCookies(cookies, managedCookies).slice(0, 120);
    }
    if (platform !== "threads") return cookies;
    const managedCookies = readManagedThreadsAccountCookies();
    // A collector lease represents exactly one account. Never merge global
    // browser-auth cookies into that lease: duplicate sessionid values can
    // silently turn a valid account search into an empty result shell.
    if (collectorProfileRequired) return expandThreadsAuthCookiesForBrowser(managedCookies);
    const mergedCookies = hasValidThreadsSessionCookie(managedCookies)
      ? mergeBrowserAuthCookies(managedCookies, cookies)
      : mergeBrowserAuthCookies(cookies, managedCookies);
    return expandThreadsAuthCookiesForBrowser(mergedCookies);
  } catch {
    return [];
  }
}

function buildThreadsSearchQueries(keywords: string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const text = cleanText(value);
    if (!text) return;
    if (!isSearchableRelevanceTerm(text)) return;
    if (text.length > 14) return;
    out.push(text);
  };
  const orderedKeywords = rankSearchKeywords(meaningfulNeedles(keywords));
  for (const keyword of orderedKeywords) {
    add(keyword);
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
  }
  for (const keyword of orderedKeywords) {
    for (const part of splitKeywords(keyword)) add(part);
  }
  for (const keyword of orderedKeywords) {
    for (const variant of buildDynamicSearchQueryVariants([keyword])) add(variant);
  }
  return [...new Set(out)].slice(0, 48);
}

export function buildInstagramHotSearchQueries(queryKeywords: string[], keywords: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const text = normalizeInstagramAuthenticatedTagQuery(value);
    if (!text || text.length < 2 || !hasHan(text)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  // Keep Instagram discovery aligned with the Threads browser path. The
  // `keywords` set is the acceptance/filtering set and may be re-ranked or
  // expanded with intent terms; using it first makes code search diverge from
  // a user's manual platform search and wastes the short authenticated page
  // window on derivative phrases. Search with queryKeywords first, then use
  // acceptance keywords only as additional coverage.
  queryKeywords.forEach(add);
  keywords.forEach(add);
  buildThreadsSearchQueries(queryKeywords).forEach(add);
  return out.slice(0, 80);
}

export function buildModelOrderedThreadsSearchQueries(keywords: string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const text = cleanText(value);
    if (!text || !isSearchableRelevanceTerm(text) || text.length > 14) return;
    if (!out.includes(text)) out.push(text);
  };
  const orderedKeywords = [...new Set([
    ...keywords.map(cleanText).filter((item) => isSearchableRelevanceTerm(item)),
    ...meaningfulNeedles(keywords),
  ])];
  // Threads Reader is materially more reliable for CJK search phrases when
  // the tokens are contiguous ("理財詐騙") instead of URL-decoded with spaces
  // ("理財 詐騙"). Preserve the controller keyword for relevance metadata,
  // but put the compact search form at the front of the request window.
  for (const keyword of orderedKeywords) {
    const parts = keyword.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || !parts.every((part) => /^[\u3400-\u9fff]+$/u.test(part))) continue;
    add(parts.join(""));
  }
  for (const keyword of orderedKeywords) add(keyword);
  for (const keyword of orderedKeywords) {
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
  }
  return out.slice(0, 48);
}

const THREADS_SEARCH_NOISE_LINES = new Set([
  "threads",
  "instagram",
  "登入",
  "登录",
  "註冊",
  "注册",
  "翻譯",
  "翻译",
  "搜尋",
  "搜索",
  "搜尋 Threads",
  "搜索 Threads",
  "使用 Instagram 帳號繼續",
  "使用 Instagram 账号继续",
  "建立新帳號",
  "创建新帐号",
  "隱私政策",
  "隐私政策",
  "Cookie 政策",
  "使用條款",
  "使用条款",
  "回報問題",
  "报告问题",
]);

function isThreadsSearchNoiseLine(line: string, query: string): boolean {
  const text = cleanText(line);
  if (!text) return true;
  if (text === query) return true;
  if (THREADS_SEARCH_NOISE_LINES.has(text)) return true;
  if (/^©\s*\d{4}/.test(text)) return true;
  if (/^[\d,.，]+(?:\s*[萬万])?$/.test(text)) return true;
  if (/^\[\d+\]$/.test(text)) return true;
  if (/^(?:\d+\s*(?:秒|分鐘|分钟|小時|小时|天|週|周|月|年)|昨天|前天)$/.test(text)) return true;
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)) return true;
  if (/^(?:所有|最新|热门|熱門)$/.test(text)) return true;
  return false;
}

function isLikelyThreadsHandle(line: string): boolean {
  const text = line.trim();
  if (!/^@?[A-Za-z0-9_.]{2,32}$/.test(text)) return false;
  if (!/[A-Za-z_]/.test(text)) return false;
  if (/^\d+(?:s|m|h|d|w)$/i.test(text)) return false;
  return !/^(?:threads|instagram|search|login|home|profile|www|net|com|t|translate|top|recent|profiles|messages|activity|insights|saved|feeds|edit|following|ghost|posts|more|for|you|new|thread)$/i.test(text);
}

export function parseThreadsSearchCardCandidates(args: {
  cards: Array<{ sourceUrl: string; text: string }>;
  query: string;
  keywords?: string[];
}): SentimentHotCandidate[] {
  const query = cleanText(args.query);
  const needles = buildRelevanceNeedles([query, ...(args.keywords || [])]);
  const out: SentimentHotCandidate[] = [];
  const seen = new Set<string>();
  for (const card of args.cards || []) {
    const urlMatch = cleanText(card.sourceUrl).match(/^https?:\/\/[^/]+\/@([^/]+)\/post\/([^/?#]+)/i);
    if (!urlMatch) continue;
    const author = decodeURIComponent(urlMatch[1]).replace(/^@+/, "");
    const sourceUrl = `https://www.threads.com/@${encodeURIComponent(author)}/post/${encodeURIComponent(urlMatch[2])}`;
    if (seen.has(sourceUrl)) continue;
    const lines = String(card.text || "").split(/\r?\n/g).map(cleanText).filter(Boolean);
    const content = cleanSentimentCandidateContent(lines
      .filter((line) => line !== author && line !== `@${author}` && line !== query)
      .filter((line) => !isThreadsSearchNoiseLine(line, query))
      .filter((line) => !/^(?:追蹤|追踪|Follow|更多|More|讚|赞|回覆|回复|轉發|转发|分享)$/i.test(line))
      .filter((line) => !/^[/／]$/.test(line) && !/^\d+(?:[.,]\d+)?\s*(?:[Kk萬万])?$/.test(line))
      .filter((line) => hasHan(line))
      .join(" "));
    if (!content || isLowQualitySentimentContent(content) || !isChineseSentimentCandidate(content)) continue;
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedKeywords = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length > 0 && matchedKeywords.length === 0) continue;
    const engagement = extractEngagementMetricsFromText(lines.join("\n"));
    const publishedAt = lines.map(normalizeThreadsVisiblePublishedAt).find(Boolean);
    const id = buildSentimentCandidateId({ platform: "threads", sourceUrl, content });
    seen.add(sourceUrl);
    out.push({
      id,
      platform: "threads",
      sourceUrl,
      author,
      content,
      media: [],
      hotScore: realSentimentHotScore(engagement),
      metrics: {
        source: "threads-account-search",
        query,
        matchedKeywords,
        recentSearch: false,
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      ...(publishedAt ? { publishedAt } : {}),
      capturedAt: new Date().toISOString(),
      warnings: [],
    });
  }
  return out;
}

export function parseThreadsSearchTextCandidates(args: {
  text: string;
  query: string;
  keywords?: string[];
  limit?: number;
  sourceUrl: string;
  sourceUrls?: string[];
}): SentimentHotCandidate[] {
  const query = cleanText(args.query);
  const lines = String(args.text || "")
    .split(/\r?\n/g)
    .map((line) => cleanText(line))
    .filter(Boolean);
  const chunks: Array<{ author: string; lines: string[] }> = [];
  let current: { author: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (isLikelyThreadsHandle(line)) {
      if (current?.lines.length) chunks.push(current);
      current = { author: line.replace(/^@/, ""), lines: [] };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  if (current?.lines.length) chunks.push(current);

  const needleSource = [query, ...(args.keywords || [])].filter(Boolean);
  const needles = buildRelevanceNeedles(needleSource);
  const out: SentimentHotCandidate[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const contentLines = chunk.lines
      .filter((line) => !isThreadsSearchNoiseLine(line, query))
      .filter((line) => hasHan(line));
    const content = cleanSentimentCandidateContent(contentLines.join(" "));
    if (isLowQualitySentimentContent(content)) continue;
    if (!isChineseSentimentCandidate(content)) continue;
    if ((content.match(/[\u3400-\u9fff]/gu) || []).length < 12) continue;
    const haystack = [content, chunk.author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0) continue;
    const engagement = extractEngagementMetricsFromText(chunk.lines.join("\n"));
    const publishedAt = chunk.lines.map(normalizeThreadsVisiblePublishedAt).find(Boolean);
    const sourceUrl = cleanText(args.sourceUrls?.[index]) || `${args.sourceUrl}#candidate-${index + 1}`;
    const id = buildSentimentCandidateId({ platform: "threads", sourceUrl, content });
    out.push({
      id,
      platform: "threads",
      sourceUrl,
      author: chunk.author || "unknown",
      content,
      media: [],
      hotScore: realSentimentHotScore(engagement),
      metrics: {
        source: "threads-search-page",
        matchedKeywords: matchedNeedles,
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      ...(publishedAt ? { publishedAt } : {}),
      capturedAt: new Date().toISOString(),
      warnings: ["Threads 搜索页面未暴露稳定媒体地址，已先保留文字热点。"],
    });
    if (out.length >= (args.limit || 10)) break;
  }
  return out;
}

async function readCandidatesFromDatabase(args: { archiveId: string; keywords: string[]; limit: number; excludeShown?: boolean }): Promise<SentimentHotCandidate[]> {
  const dbPath = path.join(resolveSentimentDataDir(), "crm.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT
        s.id,
        s.platform,
        s.url,
        s.title,
        s.content,
        s.author,
        s.keyword,
        s.keywords,
        s.published_at,
        s.found_at,
        s.first_seen_at,
        s.last_seen_at,
        s.seen_count,
        i.spread_score,
        i.influence_score,
        i.kol_score,
        i.emotions,
        i.extracted_keywords
      FROM crm_sentiment s
      LEFT JOIN crm_sentiment_insights i ON i.sentiment_id = s.id
      WHERE lower(s.platform) IN ('threads', 'instagram')
      ORDER BY
        COALESCE(i.spread_score, 0) + COALESCE(i.influence_score, 0) + COALESCE(i.kol_score, 0) + COALESCE(s.seen_count, 0) DESC,
        datetime(COALESCE(s.last_seen_at, s.found_at, s.first_seen_at)) DESC
      LIMIT 1000
    `).all();
    const excluded = args.excludeShown ? getSentimentHotRefreshExcludedIds(args.archiveId) : getSentimentHotExcludedIds(args.archiveId);
    const needles = buildRelevanceNeedles(args.keywords);
    const candidates: SentimentHotCandidate[] = [];
    for (const row of rows) {
      const platform = normalizePlatform(row.platform);
      if (!platform) continue;
      const contentCandidate = cleanSentimentCandidateContent(row.content);
      const titleCandidate = cleanSentimentCandidateContent(row.title);
      const content = !isLowQualitySentimentContent(contentCandidate)
        ? contentCandidate
        : !isLowQualitySentimentContent(titleCandidate)
          ? titleCandidate
          : "";
      const sourceUrl = cleanText(row.url);
      if (!content || !sourceUrl) continue;
      if (!isChineseSentimentCandidate(content)) continue;
      const id = buildSentimentCandidateId({ platform, sourceUrl, content });
      if (excluded.has(id)) continue;
      const haystack = [content, row.title, row.author, row.keyword, row.keywords, row.extracted_keywords].map(cleanText).join(" ").toLowerCase();
      const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
      if (needles.length && matchedNeedles.length === 0) continue;
      const relevance = Math.min(60, matchedNeedles.length * 20);
      const media = readMediaForSentiment(db, Number(row.id));
      const engagement = {
        likeCount: parseMetricNumber((safeJson(row.keywords) as any)?.like_count || (safeJson(row.extracted_keywords) as any)?.like_count),
        commentCount: parseMetricNumber((safeJson(row.keywords) as any)?.comment_count || (safeJson(row.extracted_keywords) as any)?.comment_count),
        viewCount: parseMetricNumber((safeJson(row.keywords) as any)?.view_count || row.seen_count),
      };
      const hotScore = Math.round(
        Number(row.spread_score || 0)
        + Number(row.influence_score || 0)
        + Number(row.kol_score || 0)
        + Number(row.seen_count || 0)
        + relevance,
      );
      if (hotScore < MIN_SENTIMENT_HOT_SCORE_FLOOR) continue;
      const candidate = {
        id,
        platform,
        sourceUrl,
        author: cleanText(row.author) || "unknown",
        content,
        media,
        hotScore,
        metrics: {
          source: "database",
          origin: "database",
          liveFetch: false,
          seenCount: Number(row.seen_count || 0),
          spreadScore: Number(row.spread_score || 0),
          influenceScore: Number(row.influence_score || 0),
          kolScore: Number(row.kol_score || 0),
          emotions: safeJson(row.emotions),
          keywords: safeJson(row.keywords),
          ...compactEngagementMetrics(engagement),
        },
        engagement,
        publishedAt: normalizeSentimentPublishedAt(row.published_at),
        capturedAt: cleanText(row.last_seen_at || row.found_at || row.first_seen_at) || new Date().toISOString(),
        warnings: media.filter((item) => item.warning).map((item) => item.warning as string),
      };
      candidates.push(candidate);
    }
    return candidates
      .filter(isUsefulHotCandidate)
      .sort(compareSentimentHotPriority)
      .slice(0, args.limit);
  } finally {
    db.close();
  }
}

function normalizePlatform(value: unknown): SentimentHotPlatform | null {
  const text = String(value || "").toLowerCase();
  if (text.includes("thread")) return "threads";
  if (text.includes("instagram") || text === "ins") return "instagram";
  return null;
}

function readMediaForSentiment(db: any, sentimentId: number): SentimentHotMedia[] {
  try {
    const rows = db.prepare(`
      SELECT asset_type, image_url, thumbnail_url, metrics_json
      FROM sentiment_visual_assets
      WHERE sentiment_id = ?
      ORDER BY datetime(captured_at) DESC, id DESC
      LIMIT 12
    `).all(sentimentId);
    return rows.map((row: any) => {
      const url = cleanText(row.image_url || row.thumbnail_url);
      const type = String(row.asset_type || "").toLowerCase().includes("video") ? "video" : "image";
      if (!url) return null;
      return normalizeMedia({ type, url });
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeMedia(media: { type: "image" | "video"; url: string }): SentimentHotMedia {
  if (/^https?:\/\//i.test(media.url)) {
    return { ...media, warning: "媒體仍為原始連結，寫入時會保留來源。" };
  }
  const resolved = path.isAbsolute(media.url) ? media.url : path.resolve(resolveSentimentDataDir(), media.url);
  return fs.existsSync(resolved) ? { ...media, localPath: resolved } : { ...media, warning: "媒體本地文件不存在，已保留原連結。" };
}

export async function downloadCandidatePrimaryMedia(candidate: SentimentHotCandidate): Promise<SentimentHotMedia | undefined> {
  const primary = candidate.media[0];
  if (!primary) return undefined;
  if (primary.localPath && fs.existsSync(primary.localPath)) return primary;
  if (!/^https?:\/\//i.test(primary.url)) return primary;
  try {
    const response = await fetch(primary.url, { signal: buildAbortSignalTimeout(15_000) });
    if (!response.ok) return primary;
    const contentType = response.headers.get("content-type") || "";
    if (!/^image\/|^video\//i.test(contentType)) return primary;
    const ext = extensionFromContentType(contentType, primary.type);
    const mediaDir = path.dirname(resolveRuntimeFile(`sentiment-hot-media/${candidate.id}${ext}`));
    fs.mkdirSync(mediaDir, { recursive: true });
    const localPath = path.join(mediaDir, `${candidate.id}${ext}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    return { ...primary, localPath, warning: undefined };
  } catch {
    return primary;
  }
}

async function downloadOneCandidateMediaItem(
  candidateId: string,
  item: SentimentHotMedia,
  index: number,
): Promise<SentimentHotMedia> {
  if (item.localPath && fs.existsSync(item.localPath)) return item;
  if (!/^https?:\/\//i.test(item.url)) return item;
  try {
    const response = await fetch(item.url, { signal: buildAbortSignalTimeout(15_000) });
    if (!response.ok) return item;
    const contentType = response.headers.get("content-type") || "";
    if (!/^image\/|^video\//i.test(contentType)) return item;
    const ext = extensionFromContentType(contentType, item.type);
    const mediaDir = path.dirname(resolveRuntimeFile(`sentiment-hot-media/${candidateId}-${index + 1}${ext}`));
    fs.mkdirSync(mediaDir, { recursive: true });
    const localPath = path.join(mediaDir, `${candidateId}-${index + 1}${ext}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    return { ...item, localPath, warning: undefined };
  } catch {
    return item;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(Math.max(1, limit), items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function downloadCandidateMedia(
  candidate: SentimentHotCandidate,
  limit = Number.POSITIVE_INFINITY,
  concurrency = 1,
): Promise<SentimentHotMedia[]> {
  const media = (candidate.media || []).slice(0, limit);
  if (!media.length) return [];
  const workerLimit = Math.max(1, Math.min(8, Number(concurrency) || 1));
  if (workerLimit <= 1) {
    const downloaded: SentimentHotMedia[] = [];
    for (let index = 0; index < media.length; index += 1) {
      downloaded.push(await downloadOneCandidateMediaItem(candidate.id, media[index], index));
    }
    return downloaded;
  }
  return mapLimit(media, workerLimit, (item, index) => downloadOneCandidateMediaItem(candidate.id, item, index));
}

function extensionFromContentType(contentType: string, type: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("mp4")) return ".mp4";
  return type === "video" ? ".mp4" : ".jpg";
}
