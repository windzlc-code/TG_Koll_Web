import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { PersonaArchive } from "@/core/archives/persona-archive-domain";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { withExclusiveJsonFileLock } from "@/runtime/node/json-file-lock";
import { withSentimentHotExecutionLock } from "@/lib/sentiment-hot-execution-lock";
import { readRuntimeApiConfig } from "@/runtime/node/config";
import { callTextUnderstandingModelWithFallback, extractText, getTextUnderstandingModelFallbacks, isTextModelFallbackError } from "@/lib/gemini-client";
import {
  buildSentimentCandidateId,
  getSentimentHotCandidateHistoryKeys,
  getSentimentHotExcludedIds,
  getSentimentHotRefreshExcludedIds,
  getSentimentHotShownHistoryKeys,
  getSentimentHotShownAtMap,
  getSentimentHotShownIds,
  type SentimentHotCandidate,
  type SentimentHotMedia,
  type SentimentHotPlatform,
} from "@/lib/sentiment-candidate-store";
import {
  ensureSentimentRuntime,
  resolveSentimentBackendUrl,
  resolveSentimentDataDir,
  scheduleSentimentRuntimeShutdown,
} from "@/lib/sentiment-runtime-manager";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const MIN_SENTIMENT_HOT_SCORE = 1000;
const MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT = 60;
const SENTIMENT_HOT_CANDIDATE_POOL_TARGET = 400;
const THREADS_SEARCH_CACHE_CANDIDATE_LIMIT = 2000;
const THREADS_SEARCH_CACHE_MAX_ROWS_PER_ARCHIVE = 40;
const THREADS_BROWSER_QUERY_LIMIT = 24;
const THREADS_BROWSER_QUERY_BATCH_SIZE = 6;
const THREADS_BROWSER_PAGE_LIMIT = 3;
const THREADS_BROWSER_BOOTSTRAP_QUERY_LIMIT = 4;
const THREADS_BROWSER_REQUEST_TIMEOUT_MS = 5_000;
const SENTIMENT_MODEL_KEYWORD_TARGET = 20;
const SENTIMENT_HOT_KEYWORD_MODEL = "xai/grok-4.3";
const THREADS_READER_INITIAL_QUERY_LIMIT = 24;
const THREADS_READER_TOTAL_QUERY_LIMIT = 48;
const THREADS_READER_QUERY_BATCH_SIZE = 8;
const INSTAGRAM_READER_QUERY_LIMIT = 48;
const SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS = 20_000;
const SENTIMENT_HOT_TOTAL_TIMEOUT_MS = 55_000;
const SENTIMENT_HOT_SUPPLEMENT_MIN_REMAINING_MS = 12_000;
const SENTIMENT_HOT_STRICT_PARENT_SUPPLEMENT_LIMIT = 2;
const SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const SENTIMENT_HOT_MAX_PUBLISHED_AGE_MS = 730 * 24 * 60 * 60 * 1000;
const SENTIMENT_HOT_SEARCH_STRATEGY_VERSION = 19;
const SENTIMENT_HOT_TIMEOUT_WARNING = "\u71b1\u9ede\u6293\u53d6\u5df2\u8d85\u6642\uff0c\u5df2\u505c\u6b62\u5f8c\u7e8c\u8017\u6642\u6b65\u9a5f\uff1b\u8acb\u7a0d\u5f8c\u5237\u65b0\u6216\u6aa2\u67e5 Cookie / sessionid\u3002";
const THREADS_SEARCH_CACHE_WARNING = "当前 Threads 搜索被限流，已使用 24 小时内缓存热点。";
const SENTIMENT_HOT_NORMAL_KEYWORD_TARGET = 48;
const SENTIMENT_HOT_STRICT_KEYWORD_TARGET = 36;
const SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_FILE = resolveRuntimeFile("sentiment_hot_search_strategy_cache.json");
const SENTIMENT_HOT_SEARCH_STRATEGY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SENTIMENT_HOT_SEMANTIC_RELEVANCE_VERSION = 4;
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
];

function resolvePreferredChromeExecutablePath(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildLocalChromiumLaunchOptions() {
  const executablePath = resolvePreferredChromeExecutablePath();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
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
  cookieStatuses: SentimentCookieStatus[];
  warnings: string[];
}

interface SentimentHotSearchStrategy {
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
  method: "browser" | "reader" | "failed";
  complete?: boolean;
  scope?: "authenticated_full_profile" | "public_partial" | "reader_public_partial" | "profile_visible_light" | "failed";
  lightRefreshedAt?: string;
  postMetrics?: ThreadsProfilePostHotMetrics[];
  rawText?: string;
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
    return {};
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
  add(text);
  const replacements: Array<[RegExp, string]> = [
    [/信貸/g, "信贷"],
    [/信贷/g, "信貸"],
    [/貸款/g, "贷款"],
    [/贷款/g, "貸款"],
    [/銀行/g, "银行"],
    [/银行/g, "銀行"],
    [/理財/g, "理财"],
    [/理财/g, "理財"],
    [/債務/g, "债务"],
    [/债务/g, "債務"],
    [/風控/g, "风控"],
    [/风控/g, "風控"],
  ];
  for (const [pattern, replacement] of replacements) add(text.replace(pattern, replacement));

  if (/(?:金融|信貸|信贷|貸款|贷款|信用卡|銀行|银行|理財|理财|債務|债务|風控|风控)/u.test(text)) {
    [
      "海外金融",
      "信用卡",
      "貸款",
      "贷款",
      "信貸",
      "信贷",
      "銀行貸款",
      "银行贷款",
      "貸款利率",
      "贷款利率",
      "理財",
      "理财",
      "債務",
      "债务",
      "信用分",
      "銀行審核",
      "银行审核",
      "借錢",
      "借钱",
      "債務整合",
      "债务整合",
      "房貸",
      "房贷",
      "車貸",
      "车贷",
      "信用貸款",
      "信用贷款",
      "小額貸款",
      "小额贷款",
      "貸款申請",
      "贷款申请",
      "信用評分",
      "信用评分",
    ].forEach(add);
  }

  if (/(?:汽車|汽车|修車|修车|維修|维修|保養|保养|客車|客车|大巴|底盤|底盘|煞車|刹车|傳動軸|传动轴|引擎|機油|机油)/u.test(text)) {
    [
      "汽車維修",
      "汽车维修",
      "修車",
      "修车",
      "汽車保養",
      "汽车保养",
      "引擎維修",
      "引擎维修",
      "底盤維修",
      "底盘维修",
      "煞車系統",
      "刹车系统",
      "機油保養",
      "机油保养",
      "輪胎保養",
      "轮胎保养",
      "車廠維修",
      "汽修廠",
      "二手車保養",
      "商用車維修",
      "大客車保養",
      "大巴維修",
    ].forEach(add);
  }

  if (/(?:刺青|紋身|纹身)/u.test(text)) {
    [
      "刺青",
      "紋身",
      "纹身",
      "刺青保養",
      "刺青圖案",
    ].forEach(add);
  }

  if (/(?:角色扮演|cosplay|Cosplay|二次元|動漫|动漫)/u.test(text)) {
    [
      "角色扮演",
      "Cosplay",
      "二次元",
      "動漫",
      "动漫",
      "動漫展",
      "同人展",
    ].forEach(add);
  }

  if (/(?:遊戲|游戏|手遊|手游|電競|电竞)/u.test(text)) {
    [
      "遊戲角色",
      "游戏角色",
      "手遊",
      "手游",
      "電競",
      "电竞",
    ].forEach(add);
  }

  return out.slice(0, 32);
}

function readSentimentBrowserFallbackConfig() {
  const configPath = path.join(resolveSentimentDataDir(), "sentiment-config.json");
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
    matchDomains: ["threads.com", "threads.net", "instagram.com", "facebook.com"],
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
  const missingThreadsLoginSession = platform === "threads" && valid > 0 && !hasLoginSession;
  const health: SentimentCookieHealth = cookies.length === 0
    ? "missing"
    : valid <= 0
      ? "expired"
      : missingThreadsLoginSession || expired > 0
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
    hasRequiredSessionCookie: platform !== "threads" || hasValidThreadsSessionCookie(cookies),
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
    cookies: mergeBrowserAuthCookies(managedCookies, Array.isArray(profile?.cookies) ? profile.cookies : []),
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
  "穿搭",
  "美食",
  "遊戲",
  "戀愛",
  "動漫",
  "追劇",
  "旅行",
  "工作",
  "感情",
  "女生",
  "話題",
  "討論",
  "推薦",
  "好笑",
  "實用",
  "推文",
  "文案",
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

const DOMAIN_RELEVANCE_KEYWORDS = new Set([
  "遊戲",
  "游戏",
  "動漫",
  "动漫",
  "戀愛",
  "恋爱",
  "感情",
  "穿搭",
  "美食",
  "工作",
  "旅行",
  "旅遊",
  "旅游",
  "女生",
]);

const PRIORITY_DOMAIN_KEYWORDS = new Set([
  "醫療",
  "医疗",
  "醫生",
  "医生",
  "醫院",
  "医院",
  "診所",
  "诊所",
  "醫美",
  "医美",
  "護理",
  "护理",
  "護士",
  "护士",
  "急診",
  "急诊",
  "AI",
  "人工智慧",
  "人工智能",
  "自動化",
  "自动化",
  "護膚",
  "护肤",
  "美妝",
  "美妆",
  "穿搭",
  "遊戲",
  "游戏",
  "動漫",
  "动漫",
  "二次元",
  "職場",
  "职场",
]);

function isGenericSentimentKeyword(value: string): boolean {
  const key = cleanText(value).toLowerCase();
  return GENERIC_SENTIMENT_KEYWORDS.has(key) && !DOMAIN_RELEVANCE_KEYWORDS.has(key);
}

function isWeakRelevanceKeyword(value: string): boolean {
  const keyword = cleanText(value);
  const key = keyword.toLowerCase();
  if (!keyword) return true;
  if (PRIORITY_DOMAIN_KEYWORDS.has(keyword)) return false;
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

function extractDynamicPersonaKeywords(args: { archiveName: string; pieces: string[] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string, options?: { maxLength?: number }) => {
    const text = normalizeSentimentSearchKeyword(value, { archiveName: args.archiveName, sourceText: args.pieces.join(" ") });
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };

  for (const piece of args.pieces) {
    const cleaned = cleanText(piece)
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[「」『』“”"'()[\]{}]/g, " ");
    for (const segment of cleaned.split(/[,，、。.!！?？；;：:\n\r]+/g)) {
      const text = normalizeDynamicKeyword(segment, args.archiveName);
      if (!text) continue;
      for (const token of text.split(/\s+|和|與|与|及|以及|跟/g)) add(token);
      if (!/\s/.test(text) && text.length <= 8) add(text);
    }
  }
  return out.slice(0, 8);
}

function buildSearchKeywordCandidates(args: {
  archiveName: string;
  pieces: string[];
}): string[] {
  const joined = args.pieces.join(" ");
  const out: string[] = [];
  out.push(...extractDynamicPersonaKeywords(args));
  for (const item of splitKeywords(joined)) {
    const keyword = normalizeSentimentSearchKeyword(item, { archiveName: args.archiveName, sourceText: joined });
    if (keyword) out.push(keyword);
  }
  for (const item of [...out]) {
    out.push(...expandSentimentSearchKeywordVariants(item));
  }
  return rankSearchKeywords(filterConflictingSearchKeywords([...new Set(out)])
    .filter((item) => isConcreteSearchKeyword(item))
  ).slice(0, SENTIMENT_MODEL_KEYWORD_TARGET);
}

function filterConflictingSearchKeywords(keywords: string[]): string[] {
  const hasStockDomain = keywords.some((keyword) => /(?:股市|股票|台股|美股|K線|k線|投資策略|投資心得|股票投資|股市分析)/u.test(cleanText(keyword)));
  if (!hasStockDomain) return keywords;
  const secondaryPattern = /(?:二次元|動漫|遊戲|游戏|宅文化|Cosplay|手辦|手办|美少女|女角色|角色扮演)/iu;
  const primary: string[] = [];
  const secondary: string[] = [];
  for (const keyword of keywords) {
    (secondaryPattern.test(cleanText(keyword)) ? secondary : primary).push(keyword);
  }
  return [...primary, ...secondary];
}

function rankSearchKeywords(keywords: string[]): string[] {
  return keywords
    .map((keyword, index) => {
      let score = 0;
      if (PRIORITY_DOMAIN_KEYWORDS.has(keyword)) score += 100;
      if (!isWeakRelevanceKeyword(keyword)) score += 30;
      if (keyword.length <= 4) score += 20;
      if (keyword.length > 8) score -= 25;
      return { keyword, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.keyword);
}

function isConcreteSearchKeyword(value: unknown): boolean {
  const keyword = cleanText(value);
  if (!keyword || !hasHan(keyword)) return false;
  if (keyword.length < 2 || keyword.length > 12) return false;
  if (isWeakRelevanceKeyword(keyword) || isGenericSentimentKeyword(keyword)) return false;
  if (/[()[\]{}]|(?:^|[^\d])\d{2,}(?:公分|cm|CM)?/u.test(keyword)) return false;
  const allowDailySearchKeyword = /(?:教師|教师|老師|老师|工程師|工程师|瑜伽|健身房|汽車|汽车|空服員|空服员|校園|校园|職場|职场|遊戲|游戏|科技業|科技业).{0,4}日常/u.test(keyword);
  if (/(?:幽默|接地氣|接地气|宅氣|宅气|善良|智慧|愛心|爱心|溫柔|温柔|鼓勵|鼓励|耐心|致力|充滿|充满|治癒感|疗愈感|自律感|反差魅力|視覺|视觉|傾向|倾向)/u.test(keyword)) return false;
  if (!allowDailySearchKeyword && /(?:自詡|自诩|自認|自认|說話|说话|語氣|语气|風格|风格|傾向|倾向|日常|熱門|热门|分享|穿著|穿着|身高|公分|老公|老婆|女孩|男孩|男人|女人|美女圖|美女图|身份|身分|領域|领域|語氣|语气|視覺|视觉|邊界|边界|沉穩|沉稳|高雅|親和|亲和)/u.test(keyword)) return false;
  if (/(?:的|在|裡|里|和|以及|可以|能夠|能够|充滿|充满)$/u.test(keyword)) return false;
  return true;
}

function normalizeSentimentHotSearchMode(value: unknown): SentimentHotSearchMode {
  return String(value || "").trim().toLowerCase() === "normal" ? "normal" : "strict";
}

export function normalizeSentimentHotFreshnessDays(value: unknown): number {
  const days = Math.round(Number(value));
  return Number.isFinite(days) ? Math.min(15, Math.max(0, days)) : 0;
}

export function candidateMatchesRequestedFreshness(candidate: SentimentHotCandidate, value: unknown): boolean {
  const freshnessDays = normalizeSentimentHotFreshnessDays(value);
  return freshnessDays <= 0 || candidateHasAcceptableFreshness(candidate, freshnessDays);
}

function sentimentHotKeywordTargetForMode(mode: SentimentHotSearchMode): number {
  return mode === "normal" ? SENTIMENT_HOT_NORMAL_KEYWORD_TARGET : SENTIMENT_HOT_STRICT_KEYWORD_TARGET;
}

function isStandalonePersonaVisualKeyword(value: unknown): boolean {
  return /^(?:刺青|紋身|纹身|刺青保養|刺青保养|刺青圖案|刺青图案|滿背刺青|满背刺青|鎖骨刺青|锁骨刺青)$/u.test(cleanText(value));
}

function buildStrictPersonaDomainKeywords(sourceText: string): string[] {
  const text = cleanText(sourceText);
  const out: string[] = [];
  const add = (value: string) => {
    const keyword = normalizeSentimentSearchKeyword(value, { sourceText: text });
    if (keyword && isConcreteSearchKeyword(keyword)) out.push(keyword);
  };
  const hasTattooVisual = /(?:刺青|紋身|纹身|滿背刺青|满背刺青|鎖骨刺青|锁骨刺青)/u.test(text);
  const hasCosplayDomain = /(?:Cosplay|cosplay|Coser|coser|角色扮演|動漫Cosplay|动漫Cosplay|動漫展|动漫展|漫展|同人展|二次元|動漫|动漫)/u.test(text);
  const hasGamingDomain = /(?:電競|电竞|遊戲|游戏|MOBA|射擊|射击|手遊|手游|開黑|开黑|實況|实况)/u.test(text);
  const hasFootballDomain = /(?:足球|球賽|球赛|球星|聯賽|联赛|賽事|赛事|運動系|运动系)/u.test(text);
  const hasFinanceDomain = /(?:投資|投资|理財|理财|基金|存錢|存钱|搞錢|搞钱|低門檻|低门槛)/u.test(text);
  const hasCreditDomain = /(?:信貸|信贷|貸款|贷款|信用分|信用卡|薪資|薪资|週轉|周转|債務|债务|卡債|卡债|銀行|银行)/u.test(text);
  const hasRealEstateDomain = /(?:不動產|不动产|房產|房产|房貸|房贷|置產|置产|豪宅|建案|融資|融资|東京|东京|大阪|日本高端|跨境資產|跨境资产|資產避險|资产避险)/u.test(text);
  const hasEducationDomain = /(?:教師|教师|老師|老师|校園|校园|學生|学生|師生|师生|教室|教研|成長|成长|勵志|励志|治癒|治愈)/u.test(text);
  const hasBeautyDomain = /(?:美妝|美妆|保養|保养|穿搭|護膚|护肤|彩妝|彩妆|娛樂話題|娱乐话题)/u.test(text);
  const hasYogaDomain = /(?:瑜伽|伸展|體態|体态|飲食|饮食|晨間|晨间|健身|自律|療癒|疗愈)/u.test(text);
  const hasTechDomain = /(?:工程師|工程师|程式|程序|科技|加班|理工|遊戲|游戏|社群觀察|社群观察)/u.test(text);
  const hasAutoDomain = /(?:汽車|汽车|修車|修车|維修|维修|保養|保养|客車|客车|底盤|底盘|煞車|刹车)/u.test(text);

  if (hasCosplayDomain) {
    ["動漫Cosplay", "动漫Cosplay", "二次元Cosplay", "精緻Cosplay", "精致Cosplay", "漫展Cosplay", "動漫展Cosplay", "动漫展Cosplay", "同人展Cosplay", "動漫展", "动漫展", "漫展", "同人展", "Coser穿搭", "女Coser"].forEach(add);
    if (hasTattooVisual) ["刺青Coser", "刺青Cosplay", "紋身Coser", "纹身Coser", "刺青穿搭", "刺青辣妹", "刺青角色扮演"].forEach(add);
  }
  if (hasGamingDomain) {
    ["電競遊戲", "电竞游戏", "遊戲實況", "游戏实况", "MOBA手遊", "MOBA手游", "射擊手遊", "射击手游", "組隊開黑", "组队开黑", "遊戲女玩家", "游戏女玩家"].forEach(add);
  }
  if (hasFootballDomain) {
    ["足球賽事", "足球赛事", "足球少女", "球星", "聯賽", "联赛", "賽事講評", "赛事讲评", "懂球"].forEach(add);
  }
  if (hasFinanceDomain && !hasCreditDomain && !hasRealEstateDomain) {
    ["投資理財", "投资理财", "理財心法", "理财心法", "低門檻理財", "低门槛理财", "基金存錢", "基金存钱", "清醒搞錢", "清醒搞钱"].forEach(add);
  }
  if (hasCreditDomain) {
    ["低息信貸", "低息信贷", "信用分養護", "信用分养护", "工薪信貸", "工薪信贷", "薪資規劃", "薪资规划", "小額週轉", "小额周转", "卡債整理", "卡债整理", "銀行貸款", "银行贷款", "貸款利率", "贷款利率"].forEach(add);
  }
  if (hasRealEstateDomain) {
    ["日本不動產", "日本不动产", "日本房產", "日本房产", "東京豪宅", "东京豪宅", "大阪豪宅", "海外置產", "海外置产", "跨境理財", "跨境理财", "台籍融資", "台籍融资", "日本房貸", "日本房贷", "高端建案", "資產避險", "资产避险"].forEach(add);
  }
  if (hasEducationDomain) {
    ["校園治癒", "校园治愈", "教師故事", "教师故事", "師生互動", "师生互动", "學生成長", "学生成长", "勵志教育", "励志教育", "教室日常", "溫暖教師", "温暖教师"].forEach(add);
  }
  if (hasBeautyDomain) {
    ["美妝保養", "美妆保养", "護膚心得", "护肤心得", "彩妝分享", "彩妆分享", "穿搭日常", "娛樂話題", "娱乐话题"].forEach(add);
  }
  if (hasYogaDomain) {
    ["瑜伽伸展", "體態管理", "体态管理", "晨間瑜伽", "晨间瑜伽", "飲食管理", "饮食管理", "療癒瑜伽", "疗愈瑜伽"].forEach(add);
  }
  if (hasTechDomain && !hasAutoDomain && !hasCosplayDomain && !hasGamingDomain) {
    ["工程師日常", "工程师日常", "程式開發", "程序开发", "科技觀察", "科技观察", "加班日常", "理工生活"].forEach(add);
  }
  if (hasAutoDomain) {
    ["汽車維修", "汽车维修", "修車", "修车", "汽車保養", "汽车保养", "底盤維修", "底盘维修", "煞車系統", "刹车系统", "引擎維修", "引擎维修"].forEach(add);
  }
  return rankSearchKeywords([...new Set(out)]).slice(0, SENTIMENT_HOT_STRICT_KEYWORD_TARGET);
}

function prepareSentimentHotKeywordsForMode(keywords: string[], mode: SentimentHotSearchMode, options?: { sourceText?: string; useRuleDomainFallback?: boolean }): string[] {
  const normalized = filterConflictingSearchKeywords([...new Set(
    keywords.map(cleanText).filter((item) => isConcreteSearchKeyword(item)),
  )]);
  if (mode === "normal") {
    const expanded: string[] = [...normalized];
    for (const keyword of normalized) {
      if (options?.useRuleDomainFallback) expanded.push(...expandSentimentSearchKeywordVariants(keyword));
    }
    return [...new Set(expanded.filter((item) => isConcreteSearchKeyword(item)))].slice(0, sentimentHotKeywordTargetForMode(mode));
  }
  const domainKeywords = options?.useRuleDomainFallback ? buildStrictPersonaDomainKeywords(options?.sourceText || "") : [];
  const merged = [...normalized, ...domainKeywords];
  return [...new Set(merged.filter((item) => isConcreteSearchKeyword(item)))].slice(0, sentimentHotKeywordTargetForMode(mode));
}

function extractDirectHanKeywords(args: { archiveName: string; text: string }): string[] {
  const out: string[] = [];
  const add = (value: string, options?: { maxLength?: number }) => {
    const text = normalizeSentimentSearchKeyword(value, { archiveName: args.archiveName, sourceText: args.text });
    if (!text) return;
    out.push(text);
  };
  for (const match of args.text.matchAll(/[\u3400-\u9fff]{2,12}/gu)) add(match[0]);
  return [...new Set(out)].slice(0, SENTIMENT_MODEL_KEYWORD_TARGET);
}

export function buildSentimentHotKeywords(args: {
  archive?: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>;
  prompt?: string;
  memorySummaries?: string[];
}): string[] {
  const archive = args.archive || {};
  const setup = archive.setup || {};
  const pieces = [
    archive.name,
    Array.isArray((setup as any).genres) ? (setup as any).genres.join(" ") : "",
    (setup as any).personaType,
    archive.content,
    ...(args.memorySummaries || []),
    args.prompt,
  ].map(cleanText).filter(Boolean);
  const joined = pieces.join(" ");
  const personaName = cleanText(archive.name);
  const extracted = [
    ...buildSearchKeywordCandidates({ archiveName: personaName, pieces }),
    ...extractDirectHanKeywords({ archiveName: personaName, text: joined }),
  ];
  return rankSearchKeywords([...new Set(extracted.filter(Boolean))]).slice(0, SENTIMENT_MODEL_KEYWORD_TARGET);
}

function parseModelKeywordList(text: string): string[] {
  const raw = cleanText(text).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (Array.isArray(parsed?.keywords)) return parsed.keywords.map(String);
  } catch {
    // Fall back to splitting free-form model text below.
  }
  return raw.split(/[,，、\n\r/／|]+/g).map((item) => item.trim());
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

function normalizeStrategyTermList(value: unknown, args: { archiveName?: string; sourceText: string; limit: number }): string[] {
  const raw = Array.isArray(value) ? value : parseModelKeywordList(String(value || ""));
  return [...new Set(raw
    .map((item) => normalizeSentimentSearchKeyword(item, { archiveName: args.archiveName, sourceText: args.sourceText }))
    .filter((item) => isConcreteSearchKeyword(item))
  )].slice(0, args.limit);
}

function normalizeStrategyAnchorTermList(value: unknown, args: { archiveName?: string; sourceText: string; limit: number }): string[] {
  const raw = Array.isArray(value) ? value : parseModelKeywordList(String(value || ""));
  return [...new Set(raw
    .map((item) => normalizeSentimentSearchKeyword(item, { archiveName: args.archiveName, sourceText: args.sourceText }))
    .filter((item) => item.length <= 14 && isSearchableRelevanceTerm(item))
  )].slice(0, args.limit);
}

function parseSentimentHotSearchStrategy(text: string, args: { archiveName?: string; sourceText: string }): SentimentHotSearchStrategy {
  const raw = cleanText(text).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  })();
  if (Array.isArray(parsed)) {
    return {
      ...emptySentimentHotSearchStrategy(),
      primaryQueries: normalizeStrategyTermList(parsed, { ...args, limit: SENTIMENT_MODEL_KEYWORD_TARGET }),
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      ...emptySentimentHotSearchStrategy(),
      primaryQueries: normalizeStrategyTermList(parseModelKeywordList(raw), { ...args, limit: SENTIMENT_MODEL_KEYWORD_TARGET }),
    };
  }
  const primaryQueries = normalizeStrategyTermList((parsed as any).primaryQueries || (parsed as any).queries || (parsed as any).keywords, { ...args, limit: SENTIMENT_MODEL_KEYWORD_TARGET });
  const broadQueries = normalizeStrategyTermList((parsed as any).broadQueries || (parsed as any).normalQueries || (parsed as any).expandedQueries, { ...args, limit: SENTIMENT_HOT_NORMAL_KEYWORD_TARGET });
  const requiredAnchorTerms = normalizeStrategyAnchorTermList((parsed as any).requiredAnchorTerms || (parsed as any).anchorTerms || (parsed as any).coreEntityTerms, { ...args, limit: 16 });
  const normalAnchorTerms = normalizeStrategyAnchorTermList((parsed as any).normalAnchorTerms || (parsed as any).parentAnchorTerms || requiredAnchorTerms, { ...args, limit: 16 });
  const strategy: SentimentHotSearchStrategy = {
    primaryQueries,
    broadQueries,
    ecosystemQueries: normalizeStrategyTermList((parsed as any).ecosystemQueries || (parsed as any).parentQueries || (parsed as any).highVolumeQueries || broadQueries, { ...args, limit: SENTIMENT_HOT_NORMAL_KEYWORD_TARGET }),
    requiredAnchorTerms,
    normalAnchorTerms,
    strictAcceptTerms: normalizeStrategyTermList((parsed as any).strictAcceptTerms || (parsed as any).strictTerms || (parsed as any).acceptTerms || [...requiredAnchorTerms, ...primaryQueries], { ...args, limit: SENTIMENT_MODEL_KEYWORD_TARGET }),
    normalAcceptTerms: normalizeStrategyTermList((parsed as any).normalAcceptTerms || (parsed as any).broadAcceptTerms || [...normalAnchorTerms, ...primaryQueries, ...broadQueries], { ...args, limit: SENTIMENT_HOT_NORMAL_KEYWORD_TARGET }),
    rejectTerms: normalizeStrategyTermList((parsed as any).rejectTerms || (parsed as any).excludeTerms || (parsed as any).negativeTerms, { ...args, limit: 16 }),
    domainSummary: cleanText((parsed as any).domainSummary || (parsed as any).summary),
  };
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
  const simplifiedCount = (text.match(/[车维辆发机养费选业电统难杂视线论贷银财务户话题体场实经验证问学医师护购买]/gu) || []).length;
  if (simplifiedCount === 0) return true;
  const traditionalCount = (text.match(/[車維輛發機養費選業電統難雜視線論貸銀財務戶話題體場實經驗證問學醫師護購買]/gu) || []).length;
  return traditionalCount >= Math.max(2, Math.ceil(simplifiedCount / 2));
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

function buildSegmentedSentimentHotQueryTerms(strategy: SentimentHotSearchStrategy, mode: SentimentHotSearchMode): string[] {
  const identityAnchor = cleanText(strategy.personaGuardTerms?.[0] || strategy.normalAnchorTerms[0]);
  const out: string[] = [];
  for (const term of sentimentHotStrategyTermsForMode(strategy, mode)) {
    for (const segment of segmentPersonaWords(term)) {
      const query = identityAnchor && segment !== identityAnchor ? `${identityAnchor} ${segment}` : segment;
      if (query && !out.includes(query)) out.push(query);
    }
  }
  return out;
}

function applyPersonaGuardToSentimentHotStrategy(args: {
  strategy: SentimentHotSearchStrategy;
  archiveName?: string;
  personaSeedKeywords: string[];
  sourceText: string;
}) {
  const personaGuardTerms = prepareSentimentHotKeywordsForMode(args.personaSeedKeywords, "strict", {
    sourceText: args.sourceText,
    useRuleDomainFallback: true,
  }).slice(0, 10);
  const personaIdentityAnchor = personaGuardTerms[0]
    || segmentPersonaWords(cleanText(args.archiveName))[0]
    || args.strategy.normalAnchorTerms.flatMap((term) => segmentPersonaWords(term))[0];
  args.strategy.personaGuardTerms = personaIdentityAnchor ? [personaIdentityAnchor] : personaGuardTerms.slice(0, 1);
  args.strategy.primaryQueries = [...new Set([...personaGuardTerms, ...args.strategy.primaryQueries])];
  args.strategy.strictAcceptTerms = [...new Set([...personaGuardTerms, ...args.strategy.strictAcceptTerms])];
  args.strategy.normalAcceptTerms = [...new Set([...personaGuardTerms, ...args.strategy.normalAcceptTerms])];
  if (personaIdentityAnchor) {
    args.strategy.primaryQueries = [...new Set([personaIdentityAnchor, ...args.strategy.primaryQueries])];
    args.strategy.normalAnchorTerms = [...new Set([personaIdentityAnchor, ...args.strategy.normalAnchorTerms])];
  }
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
  const requiredAnchors = strategy.requiredAnchorTerms.filter((term) => term.length >= 2);
  const normalAnchors = strategy.normalAnchorTerms.filter((term) => term.length >= 2);
  const sourceQuery = cleanText((candidate.metrics as any)?.query);
  const currentStrategyTerms = new Set(sentimentHotStrategyTermsForMode(strategy, "normal").map(cleanText));
  if (sourceQuery && sourceQuery.length <= 3 && !currentStrategyTerms.has(sourceQuery) && normalAnchors[0]) {
    const leadingContent = cleanSentimentCandidateContent(candidate.content).slice(0, 120);
    if (!matchesExactAnchor(normalAnchors[0], { ...candidate, content: leadingContent })) return false;
  }
  const personaGuardTerms = (strategy.personaGuardTerms || []).map(cleanText).filter((term) => term.length >= 2);
  if (mode === "normal") {
    if (personaGuardTerms.some(matchesLeadingAnchor) || (normalAnchors[0] && matchesLeadingAnchor(normalAnchors[0]))) return true;
    const normalAcceptTerms = strategy.normalAcceptTerms.map(cleanText).filter((term) => term.length >= 2);
    return [...new Set([...requiredAnchors, ...normalAnchors, ...normalAcceptTerms])]
      .filter(matchesLeadingAnchor).length >= 2;
  }
  if (personaGuardTerms.some(matchesLeadingAnchor)) return true;
  return requiredAnchors.filter(matchesExactAnchor).length >= 2;
}

function parseSentimentHotSemanticAcceptedIds(value: unknown): string[] | null {
  const raw = cleanText(value).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.acceptedIds)) return null;
    return [...new Set(parsed.acceptedIds.map((id: unknown) => cleanText(id)).filter(Boolean))];
  } catch {
    return null;
  }
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
  if (!args.archive || !sentimentHotStrategyHasModelTerms(args.strategy) || args.candidates.length === 0) {
    return { accepted: args.candidates, tagged: args.candidates };
  }
  const scope = crypto.createHash("sha1").update(JSON.stringify({
    version: SENTIMENT_HOT_SEMANTIC_RELEVANCE_VERSION,
    archiveId: args.archive.id,
    mode: args.searchMode,
    domain: args.strategy.domainSummary,
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
      content: cleanSentimentCandidateContent(candidate.content).slice(0, 260),
      matchedTerms: Array.isArray((candidate.metrics as any)?.matchedKeywords)
        ? (candidate.metrics as any).matchedKeywords.slice(0, 5)
        : [],
      searchQuery: cleanText((candidate.metrics as any)?.query).slice(0, 50),
      };
    });
    const result = await callTextUnderstandingModelWithFallback(
      resolveSentimentHotTextModelPreference(),
      [{ role: "user", parts: [{ text: [
        "你是社媒热点候选的语义相关性审核器。只输出 JSON，不要解释，不要 Markdown。",
        "输出格式：{\"acceptedIds\":[\"候选ID\"]}",
        `人设主领域：${args.strategy.domainSummary || cleanText(args.archive.content)}`,
        `严格模式接受范围：${args.strategy.strictAcceptTerms.slice(0, 16).join("、")}`,
        `普通模式接受范围：${args.strategy.normalAcceptTerms.slice(0, 16).join("、")}`,
        `明确排除范围：${args.strategy.rejectTerms.join("、") || "无"}`,
        `抓取模式：${args.searchMode === "strict" ? "严格垂直，只接受主领域" : "普通泛垂直，可接受主领域的消费、产品、行业、场景和相邻热点"}`,
        `本轮目标：按相关度从候选中选出 ${Math.min(args.limit, candidatePayload.length)} 条。候选已经过关键词初筛；候选数足够时必须返回恰好目标数量。正文属于人设主领域或直接父领域就应选入，只拒绝明显跨行业、同名误召回或完全无关内容。`,
        "判断必须阅读正文语义，不能因为一个歧义词或搜索词就接受。拒绝同名学校、人物、地名、网络用语及正文实际主题无关的内容。",
        "严格模式要求候选属于主领域或其直接父领域的真实专业讨论、产品、故障、价格、使用、安全、维修、行业或消费场景；不要求正文复述人设最细的职业、对象或人设名称。候选的 matchedTerms 和 searchQuery 是其被模型策略召回的证据，必须结合正文一起判断。普通模式可额外接受模型给出的相邻生态范围。",
        "不得因为候选来自同一大类但与人设的直接父领域无关而接受；必须同时符合当前模式的接受范围，并避开明确排除范围。",
        `候选：${JSON.stringify(candidatePayload)}`,
      ].join("\n") }] }],
      { temperature: 0, maxOutputTokens: 2048 },
      AbortSignal.timeout(Math.max(1_000, args.timeoutMs || 31_000)),
      {
        attemptTimeoutMs: ({ index }) => index === 0
          ? Math.min(5_000, Math.max(1_000, args.timeoutMs || 31_000))
          : Math.min(19_000, Math.max(1_000, args.timeoutMs || 31_000)),
        isUsableResponse: (data) => parseSentimentHotSemanticAcceptedIds(extractText(data)) !== null,
        isRetryableError: isTextModelFallbackError,
      },
    );
    const acceptedIds = new Set(parseSentimentHotSemanticAcceptedIds(extractText(result.data)) || []);
    if (args.allowRecovery !== false && args.searchMode === "strict" && acceptedIds.size < args.limit) {
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
          AbortSignal.timeout(45_000),
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

function buildSentimentHotSearchStrategyCacheKey(args: {
  archive?: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>;
  prompt?: string;
  memorySummaries?: string[];
  personaText: string;
}): string {
  const archive = args.archive || {};
  const payload = {
    version: SENTIMENT_HOT_SEARCH_STRATEGY_VERSION,
    id: cleanText((archive as any).id),
    name: cleanText(archive.name),
    content: cleanText(archive.content),
    setup: archive.setup || {},
    prompt: cleanText(args.prompt),
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
  return [
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
    .find(Boolean) || SENTIMENT_HOT_KEYWORD_MODEL;
}

async function buildSentimentHotSearchStrategyWithModel(args: {
  archive?: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>;
  prompt?: string;
  memorySummaries?: string[];
  warnings: string[];
  timeoutMs?: number;
}): Promise<SentimentHotSearchStrategy> {
  const archive = args.archive || {};
  const setup = archive.setup || {};
  const personaText = [
    archive.name ? `人设名称：${archive.name}` : "",
    archive.content ? `人设简介：${archive.content}` : "",
    Array.isArray((setup as any).genres) && (setup as any).genres.length ? `内容领域：${(setup as any).genres.join("、")}` : "",
    Array.isArray((setup as any).interests) && (setup as any).interests.length ? `兴趣参考：${(setup as any).interests.join("、")}` : "",
    (setup as any).personaType ? `身份类型：${(setup as any).personaType}` : "",
    (setup as any).personality ? `性格与边界：${(setup as any).personality}` : "",
    setup.tweetStyleProfile ? `推文风格：${setup.tweetStyleProfile}` : "",
    setup.tweetStyleSample ? `推文样例：${setup.tweetStyleSample}` : "",
    args.memorySummaries?.length ? `近期记忆：${args.memorySummaries.join("；")}` : "",
    args.prompt ? `本次补充要求：${args.prompt}` : "",
  ].filter(Boolean).join("\n");
  if (!personaText.trim()) return emptySentimentHotSearchStrategy();
  const cacheKey = buildSentimentHotSearchStrategyCacheKey({
    archive,
    prompt: args.prompt,
    memorySummaries: args.memorySummaries,
    personaText,
  });
  const cached = readCachedSentimentHotSearchStrategy(cacheKey);
  if (cached) return cached;

  try {
    const modelPreference = resolveSentimentHotTextModelPreference();
    const totalTimeoutMs = Math.max(8_000, args.timeoutMs || 38_000);
    const configuredModelCount = Math.max(1, getTextUnderstandingModelFallbacks(modelPreference).length);
    const attemptTimeoutMs = ({ index }: { index: number }) => configuredModelCount <= 1 ? totalTimeoutMs - 1_000 : (index === 0 ? 9_000 : 19_000);
    const result = await callTextUnderstandingModelWithFallback(
      modelPreference,
      [{
        role: "user",
        parts: [{
          text: [
            "你是 Threads / Instagram 热点搜索策略模型。你必须为任意新建人设生成可执行搜索策略，不依赖固定行业锚点。",
            "只输出 JSON 对象，不要解释，不要 Markdown。",
            "JSON 结构：",
            "{\"primaryQueries\":[\"...\"],\"broadQueries\":[\"...\"],\"requiredAnchorTerms\":[\"...\"],\"normalAnchorTerms\":[\"...\"],\"rejectTerms\":[\"...\"],\"domainSummary\":\"...\"}",
            "",
            "字段数量：primaryQueries 8-10，broadQueries 8-10，requiredAnchorTerms 4-6，normalAnchorTerms 4-6，rejectTerms 4-8。",
            "先以人设名称中明确的职业、行业或主题作为严格主领域；简介里的具体对象、品牌、地区和擅长方向只能作为子主题，不能替代或过度收窄主领域。",
            "primaryQueries 至少一半覆盖主领域的高流量通用子主题，其余覆盖简介里的细分专长，总计至少 5 类；broadQueries 覆盖主领域品牌、产品、事件、受众问题、价格选择、使用经验和行业动态。",
            "broadQueries 必须包含 2-4 个主领域高互动的受众、社区或对象词，这些词本身不能附带价格、推荐、比较等低流量意图；应根据当前人设自动推导，不能套用固定行业词。",
            "requiredAnchorTerms 是正文必须命中的主领域实体词，应优先来自人设名称所表达的职业或行业，必须能排除同名或相邻领域；禁止营养、健康、经验、攻略、比较等泛词。",
            "normalAnchorTerms 是普通模式可接受的直接父领域对象类别：每项 2-4 个汉字，第一项必须是最能唯一标识直接父领域的实体类别；禁止职业名、动作、抽象概念和细分产品组合，必须比 requiredAnchorTerms 宽一层但仍排除无关产业。",
            "rejectTerms 必须针对当前关键词最容易误召回的其他行业、同名实体和相邻但不属于直接父领域的主题，不能排除主领域内容。",
            "严格模式关键词数量不能少，只用主领域同义词和场景词收口；普通模式可扩展到直接父领域，但不能漂移到无关产业。",
            "每个搜索词脱离上下文后仍应明确属于该领域。细分职业应覆盖普通受众会讨论的故障、价格、选择、品牌、市场和事件。",
            "使用更容易在 Threads 搜到的繁体中文，可保留常用简体同义词。不要输出人格、语气、外貌、自我介绍或推理过程。",
            "",
            "当前人设资料：",
            personaText,
          ].join("\n"),
        }],
      }],
      { temperature: 0.1, maxOutputTokens: 768 },
      AbortSignal.timeout(totalTimeoutMs),
      {
        isUsableResponse: (data) => {
          const candidate = parseSentimentHotSearchStrategy(extractText(data), {
            archiveName: cleanText(archive.name),
            sourceText: personaText,
          });
          return sentimentHotStrategyHasModelTerms(candidate)
            && sentimentHotStrategyUsesThreadsChinese(candidate);
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
    if (sentimentHotStrategyHasModelTerms(strategy)) {
      console.info(`[sentiment_hot_model_strategy] model=${JSON.stringify(result.model)} domain=${JSON.stringify(strategy.domainSummary)}`);
      writeCachedSentimentHotSearchStrategy(cacheKey, strategy);
      return strategy;
    }
    args.warnings.push("模型未返回可用热点搜索策略，已改用当前人设核心领域词继续抓取。");
  } catch (error) {
    args.warnings.push("模型生成热点搜索策略失败，已改用当前人设核心领域词继续抓取：" + (error instanceof Error ? error.message : String(error)));
  }
  return emptySentimentHotSearchStrategy();
}

export async function warmSentimentHotSearchStrategy(archive: PersonaArchive): Promise<boolean> {
  const warnings: string[] = [];
  const strategy = await buildSentimentHotSearchStrategyWithModel({
    archive,
    warnings,
    timeoutMs: 45_000,
  });
  return sentimentHotStrategyHasModelTerms(strategy);
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

export function isChineseSentimentCandidate(value: unknown): boolean {
  const text = cleanText(value);
  const hanCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  if (hanCount < 6) return false;
  const kanaCount = (text.match(/[\u3040-\u30ff]/gu) || []).length;
  if (kanaCount > 0 && kanaCount >= hanCount * 0.25) return false;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;
  return hanCount >= 12 || hanCount >= latinCount * 0.3;
}

export async function fetchSentimentCookieStatuses(): Promise<SentimentCookieStatus[]> {
  const profiles = readSentimentBrowserAuthProfilesConfig();
  return (["threads", "instagram"] as SentimentHotPlatform[]).map((platform) => buildSentimentCookieStatusFromProfile(platform, profiles.find((item) => sentimentProfileMatchesPlatform(item, platform))));
}

function sentimentCookieStatusHasUsableCookies(status: SentimentCookieStatus): boolean {
  if (status.platform === "threads" && status.hasRequiredSessionCookie === false) return false;
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

function normalizeCookieForBrowserAuth(cookie: any, fallbackDomain: string) {
  if (!cookie?.name || !cookie?.value) return null;
  const expires = Number(cookie.expires);
  const sameSite = ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined;
  return {
    name: String(cookie.name),
    value: String(cookie.value),
    domain: String(cookie.domain || fallbackDomain || ".threads.net"),
    path: String(cookie.path || "/"),
    expires: Number.isFinite(expires) ? expires : -1,
    httpOnly: Boolean(cookie.httpOnly || cookie.http_only),
    secure: cookie.secure !== false,
    sameSite,
  };
}

export async function refreshSentimentBrowserCookiesForPlatform(platform: SentimentHotPlatform): Promise<{ ok: boolean; message: string }> {
  const configPath = path.join(resolveSentimentDataDir(), "sentiment-config.json");
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
      signal: AbortSignal.timeout(8000),
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
      signal: AbortSignal.timeout(5000),
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
      if (!candidateMatchesRequestedFreshness(candidate, args.freshnessDays)) continue;
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
  memorySummaries?: string[];
  limit?: number;
  refresh?: boolean;
  searchMode?: SentimentHotSearchMode;
  freshnessDays?: number;
}): Promise<FetchSentimentHotCandidatesResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const archive = args.archive;
  const archiveId = cleanText(archive?.id) || "default";
  const searchMode = normalizeSentimentHotSearchMode(args.searchMode);
  const freshnessDays = normalizeSentimentHotFreshnessDays(args.freshnessDays);
  const limit = args.limit || 10;
  const personaSeedKeywords = buildSentimentHotKeywords({
    archive,
    prompt: args.prompt,
    memorySummaries: args.memorySummaries,
  });
  const personaGuardSeedKeywords = buildSentimentHotKeywords({ archive: { name: archive?.name } });
  const personaGuardSourceText = cleanText(archive?.name);
  const sourceText = [archive?.name, archive?.content, args.prompt, ...(args.memorySummaries || [])].map(cleanText).filter(Boolean).join(" ");
  const runtimePromise = ensureSentimentRuntime().catch((error: any) => ({
    ok: false,
    url: resolveSentimentBackendUrl(),
    warning: error instanceof Error ? error.message : String(error || "unknown"),
  }));
  const prefetchedStrategy = readCachedSentimentHotSearchStrategy(buildSentimentHotSearchStrategyCacheKey({
    archive,
    prompt: args.prompt,
    memorySummaries: args.memorySummaries,
    personaText: "",
  }));
  if (prefetchedStrategy) {
    applyPersonaGuardToSentimentHotStrategy({
      strategy: prefetchedStrategy,
      archiveName: archive?.name,
      personaSeedKeywords: personaGuardSeedKeywords,
      sourceText: personaGuardSourceText,
    });
  }
  const provisionalKeywordSource = prefetchedStrategy
    ? sentimentHotStrategyTermsForMode(prefetchedStrategy, searchMode)
    : personaSeedKeywords;
  const provisionalKeywords = prepareSentimentHotKeywordsForMode(provisionalKeywordSource, searchMode, {
    sourceText,
    useRuleDomainFallback: !prefetchedStrategy,
  });
  const provisionalQueryKeywords = prefetchedStrategy
    ? prepareSentimentHotKeywordsForMode([
        ...sentimentHotStrategyTermsForMode(prefetchedStrategy, searchMode),
        ...buildSegmentedSentimentHotQueryTerms(prefetchedStrategy, searchMode),
      ], searchMode, { sourceText })
    : provisionalKeywords;
  const provisionalKeywordBatches = [provisionalQueryKeywords];
  const provisionalCacheStartedAt = Date.now();
  const provisionalCachedCandidates = meaningfulNeedles(provisionalKeywords).length > 0
    ? readThreadsSearchCandidateCache(archiveId, provisionalKeywords, Math.max(limit * 4, 40), true, searchMode)
      .filter((candidate) => candidateMatchesRequestedFreshness(candidate, freshnessDays))
    : [];
  console.info(`[sentiment_hot_stage] label=provisional-cache durationMs=${Date.now() - provisionalCacheStartedAt}`);
  const provisionalGlobalStartedAt = Date.now();
  const provisionalGlobalCandidates = prefetchedStrategy
    ? readGlobalThreadsCandidateBackfill(
        archiveId,
        [...sentimentHotStrategyTermsForMode(prefetchedStrategy, searchMode), ...provisionalKeywords],
        Math.max(limit * 4, 40),
        searchMode,
      ).filter((candidate) => candidateMatchesRequestedFreshness(candidate, freshnessDays)
        && candidateMatchesSentimentHotStrategyAnchors(candidate, prefetchedStrategy, searchMode))
    : [];
  console.info(`[sentiment_hot_stage] label=provisional-global durationMs=${Date.now() - provisionalGlobalStartedAt}`);
  const provisionalCandidateMap = new Map<string, SentimentHotCandidate>();
  for (const candidate of [...provisionalCachedCandidates, ...provisionalGlobalCandidates]) {
    const dedupeKey = sentimentCandidateDedupeKey(candidate);
    if (!provisionalCandidateMap.has(dedupeKey)) provisionalCandidateMap.set(dedupeKey, candidate);
  }
  const provisionalCandidatesForReadiness = [...provisionalCandidateMap.values()];
  const provisionalReadyCount = prefetchedStrategy
    ? provisionalCandidatesForReadiness.filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, prefetchedStrategy, searchMode)).length
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
  const strategyTimeoutMs = Math.min(30_000, remainingSentimentHotTotalBudgetMs(startedAt, 25_000));
  const strategyResult = await measureSentimentStage(
    warnings,
    "search-strategy",
    () => withSentimentTimeout(
      buildSentimentHotSearchStrategyWithModel({ archive, prompt: args.prompt, memorySummaries: args.memorySummaries, warnings, timeoutMs: strategyTimeoutMs }),
      strategyTimeoutMs + 250,
      emptySentimentHotSearchStrategy(),
    ),
  );
  if (strategyResult) {
    applyPersonaGuardToSentimentHotStrategy({
      strategy: strategyResult,
      archiveName: archive?.name,
      personaSeedKeywords: personaGuardSeedKeywords,
      sourceText: personaGuardSourceText,
    });
  }
  const hasModelStrategy = Boolean(strategyResult && sentimentHotStrategyHasModelTerms(strategyResult));
  let keywords = strategyResult ? sentimentHotStrategyTermsForMode(strategyResult, searchMode) : [];
  if (!hasModelStrategy) warnings.push("模型热点搜索策略暂不可用，已使用当前人设资料解析出的核心词继续抓取。");
  if (keywords.length === 0 && personaSeedKeywords.length > 0) {
    keywords = [...personaSeedKeywords];
  }
  if (keywords.length === 0) {
    const cachedKeywords = readArchiveScopedThreadsSearchKeywords(archiveId, SENTIMENT_MODEL_KEYWORD_TARGET, searchMode);
    if (cachedKeywords.length > 0) {
      keywords = cachedKeywords;
      warnings.push("模型关键词不可用，已改用同一人设历史真实抓取关键词继续刷新。");
    }
  }
  if (!hasModelStrategy && personaSeedKeywords.length > 0 && keywords.length < SENTIMENT_MODEL_KEYWORD_TARGET) {
    keywords = [...keywords, ...personaSeedKeywords];
  }
  keywords = prepareSentimentHotKeywordsForMode([...new Set(
    keywords
      .map((item) => normalizeSentimentSearchKeyword(item, { archiveName: archive?.name, sourceText }))
      .filter((item) => isConcreteSearchKeyword(item)),
  )], searchMode, { sourceText, useRuleDomainFallback: !hasModelStrategy });
  const queryKeywords = hasModelStrategy && strategyResult
    ? (() => {
        const strategyTerms = sentimentHotStrategyTermsForMode(strategyResult, searchMode);
        const segmentedTerms = buildSegmentedSentimentHotQueryTerms(strategyResult, searchMode);
        return prepareSentimentHotKeywordsForMode([...strategyTerms, ...segmentedTerms], searchMode, { sourceText });
      })()
    : keywords;
  warnings.push(searchMode === "normal" ? "热点抓取模式：普通（泛垂直）。" : "热点抓取模式：严格（垂直收口）。");
  warnings.push(freshnessDays > 0 ? `热点新鲜度：近 ${freshnessDays} 天。` : "热点新鲜度：不限时间。");
  const poolLimit = Math.max(limit * 40, SENTIMENT_HOT_CANDIDATE_POOL_TARGET);
  const semanticSourceTarget = hasModelStrategy ? Math.min(poolLimit, Math.max(limit, 25)) : limit;
  const hasSearchKeywords = meaningfulNeedles(keywords).length > 0;

  const initialCacheStartedAt = Date.now();
  let candidates = hasSearchKeywords
    ? sortSentimentHotCandidatePool(readThreadsSearchCandidateCache(archiveId, keywords, poolLimit, true, searchMode), keywords, poolLimit, searchMode)
      .filter((candidate) => candidateMatchesRequestedFreshness(candidate, freshnessDays))
    : [];
  console.info(`[sentiment_hot_stage] label=initial-cache durationMs=${Date.now() - initialCacheStartedAt}`);
  const initialCacheCount = candidates.length;
  const channelStats: string[] = [];
  const provisionalSourceStartedAt = Date.now();
  const provisionalCandidates = (await provisionalSourcePromise)
    .filter((candidate) => candidateMatchesRequestedFreshness(candidate, freshnessDays));
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
    candidates = sortSentimentHotCandidatePool([...byId.values()], keywords, poolLimit, searchMode);
    channelStats.push(`並行實時來源 ${provisionalCandidates.length}，新增 ${added}`);
  }

  if (hasModelStrategy && strategyResult && candidates.length < semanticSourceTarget) {
    const globalBackfill = readGlobalThreadsCandidateBackfill(
      archiveId,
      [...strategyResult.requiredAnchorTerms, ...keywords],
      semanticSourceTarget,
      searchMode,
    ).filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, searchMode));
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
      candidates = sortSentimentHotCandidatePool([...byId.values()], keywords, poolLimit, searchMode);
      writeThreadsSearchCandidateCache(archiveId, keywords, candidates, searchMode);
      channelStats.push(`共享真实候选补充 ${added}`);
    }
  }

  if (hasSearchKeywords && args.refresh === true && candidates.length < limit) {
    candidates = await fillSentimentHotCandidatesToLimit({
      archiveId,
      keywords,
      candidates,
      limit,
      refresh: true,
      searchMode,
      freshnessDays,
      warnings,
    });
    candidates = candidates.slice(0, poolLimit);
  }

  const cachedReadyCount = hasSearchKeywords
    ? (hasModelStrategy && strategyResult
      ? candidates.filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, searchMode)).length
      : sortRelevantHotCandidates(candidates, keywords, poolLimit, searchMode).length)
    : 0;
  const shouldFetchLiveCandidates = hasSearchKeywords
    && (args.refresh === true || candidates.length < semanticSourceTarget || cachedReadyCount < semanticSourceTarget);
  if (hasSearchKeywords && args.refresh === true && candidates.length >= limit && cachedReadyCount < semanticSourceTarget) {
    warnings.push(`當前相關候選不足，已繼續補充實時來源。`);
  }
  let liveThreadsCandidateCount = 0;
  if (shouldFetchLiveCandidates) {
    const beforeThreadsCount = candidates.length;
    const liveDeficit = Math.max(1, semanticSourceTarget - cachedReadyCount);
    const liveCollectionLimit = Math.min(poolLimit, Math.max(semanticSourceTarget, Math.min(30, liveDeficit * 3)));
    const threadsTimeoutMs = Math.min(20_000, remainingSentimentHotTotalBudgetMs(startedAt, 18_000));
    const threadsCandidates = await measureSentimentStage(
      warnings,
      "threads-search",
      () => withSentimentTimeout(
        fetchThreadsSearchPageCandidates({
          archiveId,
          keywords,
          queryKeywords,
          limit: liveCollectionLimit,
          refresh: args.refresh === true,
          searchMode,
          deadlineAt: Date.now() + threadsTimeoutMs - 500,
        }),
        threadsTimeoutMs,
        [],
      ),
    ).catch((error) => {
      warnings.push("\u0054\u0068\u0072\u0065\u0061\u0064\u0073\u0020\u0072\u0065\u0061\u0064\u0065\u0072\u0020\u6293\u53d6\u5931\u6557\uff1a" + (error instanceof Error ? error.message : String(error)));
      return [];
    });
    liveThreadsCandidateCount = threadsCandidates.length;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
    for (const candidate of threadsCandidates) {
      if (!candidateMatchesRequestedFreshness(candidate, freshnessDays)) continue;
      const dedupeKey = sentimentCandidateDedupeKey(candidate);
      if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
        byId.set(candidate.id, candidate);
        byKey.add(dedupeKey);
      }
    }
    candidates = sortSentimentHotCandidatePool([...byId.values()], keywords, poolLimit, searchMode);
    channelStats.push(`Threads 原始 ${threadsCandidates.length}，新增 ${Math.max(0, candidates.length - beforeThreadsCount)}`);
  }
  if (candidates.length > 0) {
    warnings.push(shouldFetchLiveCandidates
      ? (liveThreadsCandidateCount > 0
        ? (args.refresh ? "\u5df2\u5373\u6642\u5237\u65b0\u0020\u0054\u0068\u0072\u0065\u0061\u0064\u0073\u0020\u0072\u0065\u0061\u0064\u0065\u0072\u0020\u4e2d\u6587\u71b1\u9ede\u3002" : "\u5df2\u4f7f\u7528\u0020\u0054\u0068\u0072\u0065\u0061\u0064\u0073\u0020\u0072\u0065\u0061\u0064\u0065\u0072\u0020\u6293\u53d6\u4e2d\u6587\u71b1\u9ede\u3002")
        : "已檢查 Threads 真實來源，本輪無新增可用候選，已使用當前人設候選池。")
      : "已從當前人設候選池刷新熱點。");
  }

  if (hasSearchKeywords && shouldFetchLiveCandidates && candidates.length < limit) {
    candidates = await fillSentimentHotCandidatesToLimit({
      archiveId,
      keywords,
      candidates,
      limit,
      refresh: args.refresh === true,
      searchMode,
      freshnessDays,
      warnings,
    });
    candidates = candidates.slice(0, Math.max(limit * 40, SENTIMENT_HOT_CANDIDATE_POOL_TARGET));
  }

  const hasFastReturnCandidates = cachedReadyCount >= semanticSourceTarget;

  const preInstagramReadyCount = hasSearchKeywords
    ? (hasModelStrategy && strategyResult
      ? candidates.filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, searchMode)).length
      : sortRelevantHotCandidates(candidates, keywords, poolLimit, searchMode).length)
    : 0;
  if (shouldFetchLiveCandidates && preInstagramReadyCount < limit && hasSentimentHotTotalBudget(startedAt, SENTIMENT_HOT_SUPPLEMENT_MIN_REMAINING_MS)) {
    const beforeInstagramCount = candidates.length;
    const instagramCandidates = await measureSentimentStage(
      warnings,
      "instagram-reader",
      () => withSentimentTimeout(
        fetchInstagramReaderSearchCandidates({
          archiveId,
          keywords,
          queries: buildOrderedSentimentQueries(buildThreadsSearchQueries(queryKeywords), args.refresh ? Date.now() + candidates.length : candidates.length, args.refresh === true).slice(0, INSTAGRAM_READER_QUERY_LIMIT),
          limit: poolLimit,
          refresh: args.refresh === true,
        }),
        Math.min(20_000, remainingSentimentHotTotalBudgetMs(startedAt, 8_000)),
        [],
      ),
    ).catch((error) => {
      warnings.push("Instagram reader 抓取失敗：" + (error instanceof Error ? error.message : String(error)));
      return [];
    });
    let instagramAddedCount = 0;
    if (instagramCandidates.length > 0) {
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
      for (const candidate of instagramCandidates) {
        if (!candidateMatchesRequestedFreshness(candidate, freshnessDays)) continue;
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
          byId.set(candidate.id, candidate);
          byKey.add(dedupeKey);
          instagramAddedCount += 1;
        }
        if (byId.size >= poolLimit) break;
      }
      candidates = sortSentimentHotCandidatePool([...byId.values()], keywords, poolLimit, searchMode);
      warnings.push(args.refresh ? `已即時刷新 Instagram reader 候選 ${instagramCandidates.length} 篇。` : `已加入 Instagram reader 候選 ${instagramCandidates.length} 篇。`);
    }
    channelStats.push(`Instagram 原始 ${instagramCandidates.length}，新增 ${instagramAddedCount}，補充前 ${beforeInstagramCount}`);
  } else if (shouldFetchLiveCandidates && hasFastReturnCandidates) {
    channelStats.push(`Instagram 已跳過，已有 ${candidates.length}/${limit} 篇候選，使用快速返回`);
  } else if (shouldFetchLiveCandidates && preInstagramReadyCount < limit) {
    pushSentimentHotWarning(warnings, SENTIMENT_HOT_TIMEOUT_WARNING);
    channelStats.push("Instagram 已跳過，剩餘時間不足");
  } else if (shouldFetchLiveCandidates) {
    channelStats.push(`Instagram 已跳過，預篩 ${preInstagramReadyCount}/${limit}`);
  }

  const runtime = await measureSentimentStage(warnings, "runtime", () => withSentimentTimeout(
    runtimePromise,
    Math.min(4_000, remainingSentimentHotTotalBudgetMs(startedAt, 16_000)),
    { ok: false, url: resolveSentimentBackendUrl(), warning: "舆情后台启动超时，已继续使用网页实时搜索。" },
  ));
  if (!runtime.ok && runtime.warning) pushSentimentHotWarning(warnings, runtime.warning);
  let cookieStatuses = await measureSentimentStage(warnings, "cookie-status", () => withSentimentTimeout(fetchSentimentCookieStatuses().catch(() => []), Math.min(1_500, remainingSentimentHotTotalBudgetMs(startedAt, 16_000)), [
    { platform: "threads" as const, health: "unknown" as const, label: "Threads", message: "\u8206\u60c5\u0020\u0043\u006f\u006f\u006b\u0069\u0065\u0020\u72c0\u614b\u6aa2\u67e5\u8d85\u6642\u3002" },
    { platform: "instagram" as const, health: "unknown" as const, label: "Instagram", message: "\u8206\u60c5\u0020\u0043\u006f\u006f\u006b\u0069\u0065\u0020\u72c0\u614b\u6aa2\u67e5\u8d85\u6642\u3002" },
  ]));
  if (shouldFetchLiveCandidates && !hasFastReturnCandidates && runtime.ok && hasSentimentHotTotalBudget(startedAt, 7_000)) {
    cookieStatuses = await measureSentimentStage(warnings, "cookie-refresh", () => withSentimentTimeout(refreshSentimentBrowserCookies(cookieStatuses, warnings), Math.min(6_000, remainingSentimentHotTotalBudgetMs(startedAt, 5_000)), cookieStatuses));
  } else if (shouldFetchLiveCandidates && !hasFastReturnCandidates && runtime.ok) {
    pushSentimentHotWarning(warnings, SENTIMENT_HOT_TIMEOUT_WARNING);
  }
  const usableSources = cookieStatuses
    .filter(sentimentCookieStatusHasUsableCookies)
    .map((status) => status.platform);
  if (shouldFetchLiveCandidates && !hasFastReturnCandidates && runtime.ok && usableSources.length > 0 && hasSentimentHotTotalBudget(startedAt, 4_000)) {
    await measureSentimentStage(warnings, "realtime-scan", () => withSentimentTimeout(triggerRealtimeSentimentScan(usableSources, warnings), Math.min(6_000, remainingSentimentHotTotalBudgetMs(startedAt, 3_000)), undefined));
  }

  if (hasSearchKeywords && candidates.length < limit) {
    const beforeDatabaseCount = candidates.length;
    const databaseCandidates = await readCandidatesFromDatabase({ archiveId, keywords, limit: poolLimit, excludeShown: args.refresh === true });
    let databaseAddedCount = 0;
    if (databaseCandidates.length > 0) {
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const byKey = new Set(candidates.map((candidate) => sentimentCandidateDedupeKey(candidate)));
      for (const candidate of databaseCandidates) {
        if (!candidateMatchesRequestedFreshness(candidate, freshnessDays)) continue;
        const dedupeKey = sentimentCandidateDedupeKey(candidate);
        if (!byId.has(candidate.id) && !byKey.has(dedupeKey)) {
          byId.set(candidate.id, candidate);
          byKey.add(dedupeKey);
          databaseAddedCount += 1;
        }
        if (byId.size >= poolLimit) break;
      }
      candidates = sortSentimentHotCandidatePool([...byId.values()], keywords, poolLimit, searchMode);
    }
    channelStats.push(`資料庫原始 ${databaseCandidates.length}，新增 ${databaseAddedCount}，補充前 ${beforeDatabaseCount}`);
  }
  if (shouldFetchLiveCandidates && !hasFastReturnCandidates && runtime.ok && usableSources.length > 0 && hasSearchKeywords && candidates.length < limit && hasSentimentHotTotalBudget(startedAt, 5_000)) {
    const beforeWaitCount = candidates.length;
    candidates = await waitForMoreSentimentHotCandidates({
      archiveId,
      keywords,
      candidates,
      limit: poolLimit,
      excludeShown: true,
      searchMode,
      freshnessDays,
    });
    if (candidates.length > beforeWaitCount) {
      channelStats.push(`即時掃描新增 ${candidates.length - beforeWaitCount}`);
      warnings.push(`\u5df2\u7b49\u5f85\u5f8c\u53f0\u5be6\u6642\u6383\u63cf\u56de\u586b\uff0c\u540c\u4eba\u8a2d\u95dc\u9375\u8a5e\u5019\u9078\u589e\u52a0\u5230 ${Math.min(candidates.length, limit)}/${limit} \u7bc7\u3002`);
    }
  }
  if (!hasSearchKeywords) {
    warnings.push("\u7576\u524d\u4eba\u8a2d\u6c92\u6709\u89e3\u6790\u51fa\u53ef\u641c\u7d22\u95dc\u9375\u8a5e\uff0c\u5df2\u505c\u6b62\u6cdb\u5316\u641c\u7d22\uff1b\u8acb\u5148\u5728\u4eba\u8a2d\u7c21\u4ecb\u88dc\u5145\u660e\u78ba\u7684\u9818\u57df\u3001\u8208\u8da3\u6216\u8077\u696d\u8a2d\u5b9a\u3002");
  } else if (candidates.length < limit) {
    candidates = await fillSentimentHotCandidatesToLimit({
      archiveId,
      keywords,
      candidates,
      limit,
      refresh: args.refresh === true,
      searchMode,
      freshnessDays,
      warnings,
    });
    candidates = candidates.slice(0, Math.max(limit * 40, SENTIMENT_HOT_CANDIDATE_POOL_TARGET));
  }
  if (runtime.ok && usableSources.length > 0) {
    void syncSentimentKeywords(keywords).catch(() => undefined);
    const missingSources = cookieStatuses
      .filter((status) => !sentimentCookieStatusHasUsableCookies(status))
      .map((status) => sentimentCookiePlatformLabel(status.platform));
    if (missingSources.length > 0 && missingSources.length < cookieStatuses.length) {
      warnings.push(`${missingSources.join(" / ")} 缺少有效 Cookie，已跳过对应平台真实扫描；其余平台仍会继续使用。`);
    }
  } else if (runtime.ok) {
    warnings.push("\u0054\u0068\u0072\u0065\u0061\u0064\u0073\u0020\u002f\u0020\u0049\u006e\u0073\u0074\u0061\u0067\u0072\u0061\u006d\u0020\u7f3a\u5c11\u6709\u6548\u0020\u0043\u006f\u006f\u006b\u0069\u0065\uff0c\u5df2\u8df3\u904e\u771f\u5be6\u6383\u63cf\uff1b\u8acb\u5148\u5728\u8206\u60c5\u0020\u0043\u006f\u006f\u006b\u0069\u0065\u0020\u914d\u7f6e\u4e2d\u6388\u6b0a\u5f8c\u518d\u5237\u65b0\u6293\u53d6\u3002");
  }
  if (candidates.length < limit && !hasSentimentHotTotalBudget(startedAt, 1_000)) {
    pushSentimentHotWarning(warnings, SENTIMENT_HOT_TIMEOUT_WARNING);
  }

  let modelParentCandidatePool: SentimentHotCandidate[] = [];
  let parentSupplementCount = 0;
  if (hasModelStrategy && strategyResult) {
    const strategyCandidatePool = candidates;
    modelParentCandidatePool = strategyCandidatePool.filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, "normal"));
    // Normal mode is the broad vertical search path. Its keyword quality
    // filter has already removed off-topic results; applying model anchors a
    // second time here can collapse a healthy live pool (for example 29
    // browser results down to 3). Keep anchor narrowing for strict mode only.
    candidates = searchMode === "strict"
      ? strategyCandidatePool.filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, searchMode))
      : strategyCandidatePool;
  }
  const displayCandidatePool = candidates;
  candidates = finalizeSentimentHotCandidatesForDisplay(displayCandidatePool, limit, { archiveId, keywords, excludeShown: true, searchMode, freshnessDays });
  if (candidates.length < limit) {
    const selectedKeys = new Set(candidates.flatMap((candidate) => getSentimentHotCandidateHistoryKeys(candidate)));
    const shownAtMap = getSentimentHotShownAtMap(archiveId);
    const supplementLimit = limit - candidates.length;
    const archiveHistory = readThreadsSearchCandidateCache(archiveId, keywords, poolLimit, false, searchMode)
      .filter((candidate) => !hasModelStrategy || !strategyResult || candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, searchMode));
    const supplements = finalizeSentimentHotCandidatesForDisplay([...displayCandidatePool, ...archiveHistory], poolLimit, {
      archiveId,
      keywords,
      excludeShown: false,
      searchMode,
      freshnessDays,
    })
      .filter((candidate) => {
        const historyKeys = getSentimentHotCandidateHistoryKeys(candidate);
        return historyKeys.every((key) => !selectedKeys.has(key));
      })
      .sort((a, b) => compareSentimentHotFreshness(a, b) || (shownAtMap.get(a.id) || 0) - (shownAtMap.get(b.id) || 0))
      .slice(0, supplementLimit);
    if (supplements.length > 0) {
      candidates = [...candidates, ...supplements];
      warnings.push(`新候選不足時已按新鮮度補充 ${supplements.length} 篇同人設高熱度候選。`);
    }
  }
  if (candidates.length < limit && modelParentCandidatePool.length > 0) {
    const selectedKeys = new Set(candidates.flatMap((candidate) => getSentimentHotCandidateHistoryKeys(candidate)));
    const parentSupplements = finalizeSentimentHotCandidatesForDisplay(modelParentCandidatePool, poolLimit, {
      archiveId,
      keywords,
      excludeShown: false,
      searchMode: "normal",
      freshnessDays,
    })
      .filter((candidate) => getSentimentHotCandidateHistoryKeys(candidate).every((key) => !selectedKeys.has(key)))
      .slice(0, searchMode === "strict"
        ? Math.min(limit - candidates.length, SENTIMENT_HOT_STRICT_PARENT_SUPPLEMENT_LIMIT - parentSupplementCount)
        : limit - candidates.length);
    if (parentSupplements.length > 0) {
      candidates = [...candidates, ...parentSupplements];
      parentSupplementCount += parentSupplements.length;
      warnings.push(`最终去重后已用模型直接父领域候选补充 ${parentSupplements.length} 篇。`);
    }
  }
  if (candidates.length < limit && hasModelStrategy && strategyResult) {
    const globalParentPool = readGlobalThreadsCandidateBackfill(
      archiveId,
      sentimentHotStrategyTermsForMode(strategyResult, "normal"),
      Math.max(limit * 4, 40),
      "normal",
    ).filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategyResult, "normal"));
    const selectedKeys = new Set(candidates.flatMap((candidate) => getSentimentHotCandidateHistoryKeys(candidate)));
    const globalSupplements = finalizeSentimentHotCandidatesForDisplay(globalParentPool, poolLimit, {
      archiveId,
      keywords,
      excludeShown: false,
      searchMode: "normal",
      freshnessDays,
    })
      .filter((candidate) => getSentimentHotCandidateHistoryKeys(candidate).every((key) => !selectedKeys.has(key)))
      .slice(0, searchMode === "strict"
        ? Math.min(limit - candidates.length, SENTIMENT_HOT_STRICT_PARENT_SUPPLEMENT_LIMIT - parentSupplementCount)
        : limit - candidates.length);
    if (globalSupplements.length > 0) {
      candidates = [...candidates, ...globalSupplements];
      parentSupplementCount += globalSupplements.length;
      warnings.push(`当前人设候选不足，已用模型父领域真实候选补充 ${globalSupplements.length} 篇。`);
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
  if (detailTargetCount > 0) {
    const detailStartedAt = Date.now();
    candidates = await enrichThreadsCandidateDetails(candidates, { force: forceDetailRefresh });
    const resolvedViewCount = candidates.filter((candidate) => (
      typeof candidate.engagement?.viewCount === "number"
      || typeof (candidate.metrics as any)?.view_count === "number"
      || typeof (candidate.metrics as any)?.viewCount === "number"
      || typeof (candidate.metrics as any)?.views === "number"
    )).length;
    channelStats.push(`原帖浏览 ${resolvedViewCount}/${candidates.length}，耗时 ${Date.now() - detailStartedAt}ms`);
    if (resolvedViewCount > 0) {
      writeThreadsSearchCandidateCache(archiveId, keywords, candidates, searchMode);
    }
    if (resolvedViewCount < candidates.length) {
      warnings.push(`已从原帖详情获取 ${resolvedViewCount}/${candidates.length} 条真实浏览量；其余原帖暂未公开或详情读取失败。`);
    }
  }
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
  scheduleSentimentRuntimeShutdown();
  return { candidates, keywords, searchMode, freshnessDays, cookieStatuses, warnings };
}

export async function fetchSentimentHotCandidates(args: {
  archive?: PersonaArchive;
  prompt?: string;
  memorySummaries?: string[];
  limit?: number;
  refresh?: boolean;
  searchMode?: SentimentHotSearchMode;
  freshnessDays?: number;
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
    const normalized = candidateMeetsDisplayQuality({ ...candidate, content }, qualityKeywords, qualityMode, args.freshnessDays);
    if (!normalized) return;
    seen.add(normalized.id);
    seenDedupeKeys.add(dedupeKey);
    out.push(normalized);
  };

  for (const candidate of args.candidates) add(candidate);
  if (out.length >= args.limit) return out.slice(0, args.limit);

  const fallbackCandidates = [
    ...readThreadsSearchCandidateCache(args.archiveId, args.keywords, Math.max(args.limit * 20, SENTIMENT_HOT_CANDIDATE_POOL_TARGET), true, args.searchMode),
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
  if (!content || isLowQualitySentimentContent(content)) return true;
  if (!isChineseSentimentCandidate(content)) return true;
  if (candidateLooksOffTopicForKeywords(content, keywords)) return true;
  const hanCount = sentimentHotHanCount(content);
  if (/threads\s*(?:log\s*in|login)|join threads|log in with instagram|page is gone|not all who wander are lost/i.test(content)) return true;
  if (/^\s*(?:https?:\/\/|www\.)/i.test(content) && hanCount < 40) return true;
  const normalized = { ...candidate, content };
  const needles = buildRelevanceNeedles(keywords);
  const strongNeedles = buildStrongRelevanceNeedles(keywords);
  const matchedCount = countMatchedNeedles(normalized, needles);
  const matchedStrongCount = countMatchedNeedles(normalized, strongNeedles);
  const hasStrongTopicSupport = matchedStrongCount >= 1 || matchedCount >= 2;
  if (hanCount < MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT) return true;
  if (hanCount < 40 && /(?:私訊|私信).*(?:下單|下单|購買|购买|領券|领券)/u.test(content)) return true;
  if (/(.)\1{8,}/u.test(content)) return true;
  if (hasStrongTopicSupport && keywords.length > 0 && candidateMatchesCurrentKeywords(normalized, keywords)) return false;
  if (/(.)\1{8,}/u.test(content)) return true;
  if (candidateLooksOffTopic({ ...candidate, content })) return true;
  if (keywords.length > 0 && !candidateMatchesCurrentKeywords({ ...candidate, content }, keywords)) return true;
  return false;
}

function isFinanceSentimentKeywordSet(keywords: string[]): boolean {
  return keywords.some((keyword) => /(?:金融|信貸|信贷|貸款|贷款|信用卡|銀行|银行|理財|理财|債務|债务|房貸|房贷|車貸|车贷|徵信|征信|借錢|借钱|利率)/u.test(cleanText(keyword)));
}

function candidateLooksOffTopicForKeywords(content: string, keywords: string[]): boolean {
  if (!isFinanceSentimentKeywordSet(keywords)) return false;
  return /(?:星座|運勢|运势|牡羊|白羊|塔羅|塔罗|同居|帶套|带套|恐怖情人|女仔望過嚟|過來人警世|纯点|純點|點位|点位|座標|坐标|地圖|地图|髮圈|发圈|藥師夢|药师梦)/u.test(content);
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

function remainingSentimentHotTotalBudgetMs(startedAt: number, reserveMs = 0): number {
  return Math.max(1_000, SENTIMENT_HOT_TOTAL_TIMEOUT_MS - (Date.now() - startedAt) - reserveMs);
}

function hasSentimentHotTotalBudget(startedAt: number, minRemainingMs = 1_000): boolean {
  return SENTIMENT_HOT_TOTAL_TIMEOUT_MS - (Date.now() - startedAt) >= minRemainingMs;
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
      signal: AbortSignal.timeout(5_000),
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
  return [...baseQueries, ...rotateSentimentQueries(supplemental, refresh ? seed : 0)];
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
  const addQualityIntentQueries = (value: string) => {
    const text = cleanText(value);
    if (!text || !hasHan(text) || text.length < 2 || text.length > 10) return;
    for (const intent of SENTIMENT_HOT_GENERIC_QUERY_INTENTS) {
      add(`${text} ${intent}`, { maxLength: 18 });
    }
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
    addQualityIntentQueries(query);
    for (const variant of expandSentimentSearchKeywordVariants(query)) addQualityIntentQueries(variant);
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
  for (const keyword of meaningfulNeedles(keywords).filter(isSearchableRelevanceTerm)) {
    add(keyword);
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
    for (const part of splitKeywords(keyword)) add(part);
    const runs = keyword.match(/[\u3400-\u9fff]{2,}/gu) || [];
    for (const run of runs) {
      add(run);
      for (const word of segmentPersonaWords(run)) add(word);
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
    if (isStandalonePersonaVisualKeyword(keyword)) return;
    if (!out.some((item) => item.toLowerCase() === keyword.toLowerCase())) out.push(keyword);
  };
  for (const keyword of meaningfulNeedles(keywords).filter(isSearchableRelevanceTerm)) {
    add(keyword);
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
    for (const part of splitKeywords(keyword)) add(part);
    const runs = keyword.match(/[\u3400-\u9fff]{2,}/gu) || [];
    for (const run of runs) {
      add(run);
      for (const word of segmentPersonaWords(run)) add(word);
    }
  }
  return out.slice(0, 48);
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
    .filter((keyword) => keyword.length >= 3 && isSearchableRelevanceTerm(keyword) && !isGenericSentimentKeyword(keyword.toLowerCase())))];
}

function isUsefulHotCandidate(candidate: SentimentHotCandidate): boolean {
  return Number(candidate.hotScore || 0) >= MIN_SENTIMENT_HOT_SCORE;
}

function sentimentCandidateSource(candidate: SentimentHotCandidate): string {
  return cleanText((candidate.metrics as any)?.source || "");
}

function sentimentCandidateSourceTier(candidate: SentimentHotCandidate): string {
  if (isArchiveScopedFallbackCandidate(candidate)) return "fallback_history";
  const source = sentimentCandidateSource(candidate);
  if (source === "threads-account-search" || source === "threads-reader-search" || source === "threads-search-page") return "primary_threads_search";
  if (source === "instagram-reader-search") return "supplement_instagram_search";
  return "primary_hot";
}

function sentimentHotHanCount(value: unknown): number {
  return (cleanSentimentCandidateContent(value).match(/[\u3400-\u9fff]/gu) || []).length;
}

function hasMinimumSentimentHotContentLength(candidate: SentimentHotCandidate): boolean {
  return sentimentHotHanCount(candidate.content) >= MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT;
}

function minimumSentimentHotHanCountForCandidate(candidate: SentimentHotCandidate): number {
  const tier = sentimentCandidateSourceTier(candidate);
  if (tier === "primary_threads_search") return 12;
  if (tier === "supplement_instagram_search") return 30;
  if (tier === "fallback_history") return 18;
  return MIN_SENTIMENT_HOT_QUALITY_HAN_COUNT;
}

function isNoisyReaderCandidateContent(candidate: SentimentHotCandidate, content: string): boolean {
  const source = sentimentCandidateSource(candidate);
  if (source !== "threads-account-search" && source !== "threads-reader-search" && source !== "threads-search-page" && source !== "instagram-reader-search") return false;
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

function candidateLooksOffTopicForStrictMode(content: string, keywords: string[]): boolean {
  const joinedKeywords = keywords.map(cleanText).join(" ");
  if (/(?:Cosplay|Coser|角色扮演|漫展|動漫展|动漫展)/iu.test(joinedKeywords)
    && /(?:GPT|Gemini|AI|LLM|提示詞|提示词|角色卡|對話框|对话框|虛擬聊聊|虚拟聊聊|靈魂的容器|灵魂的容器|角色連結|角色链接)/iu.test(content)) {
    return true;
  }
  return false;
}

function sentimentHotPublishedAtMs(candidate: SentimentHotCandidate): number | null {
  const parsed = Date.parse(String(candidate.publishedAt || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateHasAcceptableFreshness(candidate: SentimentHotCandidate, freshnessDays = 0): boolean {
  const publishedAt = sentimentHotPublishedAtMs(candidate);
  if (publishedAt === null) {
    if (normalizeSentimentHotFreshnessDays(freshnessDays) > 0) return false;
    return !isArchiveScopedFallbackCandidate(candidate) && sentimentCandidateSource(candidate) !== "database";
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

function candidateMeetsDisplayQuality(candidate: SentimentHotCandidate, keywords: string[] = [], searchMode: SentimentHotSearchMode = "normal", freshnessDays = 0): SentimentHotCandidate | null {
  const content = cleanSentimentCandidateContent(candidate.content || "");
  if (!candidate?.id || !content) return null;
  if (isLowQualitySentimentContent(content) || !isChineseSentimentCandidate(content)) return null;
  const normalized: SentimentHotCandidate = {
    ...candidate,
    content,
    metrics: {
      ...(candidate.metrics || {}),
      sourceTier: sentimentCandidateSourceTier(candidate),
    },
  };
  if ((normalized.metrics as any)?.semanticRelevant === false) return null;
  if (!candidateHasAcceptableFreshness(normalized, freshnessDays)) return null;
  if (!isUsefulHotCandidate(normalized)) return null;
  if (sentimentHotHanCount(content) < minimumSentimentHotHanCountForCandidate(normalized)) return null;
  if (isNoisyReaderCandidateContent(normalized, content)) return null;
  const relevanceKeywords = keywords;
  if (relevanceKeywords.length > 0 && candidateLooksOffTopicForKeywords(content, relevanceKeywords)) return null;
  if (searchMode === "strict" && candidateLooksOffTopicForStrictMode(content, relevanceKeywords)) return null;
  if (relevanceKeywords.length > 0 && !candidateMatchesCurrentKeywords(normalized, relevanceKeywords, searchMode)) return null;
  return normalized;
}

function uniqueSentimentWarnings(warnings: unknown[]): string[] {
  return [...new Set(warnings.map(cleanText).filter(Boolean))];
}

function sortUsefulHotCandidates(candidates: SentimentHotCandidate[], limit: number): SentimentHotCandidate[] {
  return candidates
    .map((candidate) => candidateMeetsDisplayQuality(candidate))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate))
    .sort((a, b) => compareSentimentHotFreshness(a, b) || b.hotScore - a.hotScore)
    .slice(0, limit);
}

function sortRelevantHotCandidates(candidates: SentimentHotCandidate[], keywords: string[], limit: number, searchMode: SentimentHotSearchMode = "normal"): SentimentHotCandidate[] {
  return sortUsefulHotCandidates(
    candidates.filter((candidate) => candidateMatchesCurrentKeywords(candidate, keywords, searchMode)),
    limit,
  );
}

function sortSentimentHotCandidatePool(candidates: SentimentHotCandidate[], keywords: string[], limit: number, searchMode: SentimentHotSearchMode = "normal"): SentimentHotCandidate[] {
  const relevanceNeedles = buildRelevanceNeedlesForMode(keywords, searchMode);
  return candidates
    .map((candidate) => candidateMeetsDisplayQuality(candidate, keywords, searchMode))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate))
    .sort((a, b) => {
      if (searchMode === "strict" && relevanceNeedles.length > 0) {
        const relevanceDelta = countMatchedNeedles(b, relevanceNeedles) - countMatchedNeedles(a, relevanceNeedles);
        if (relevanceDelta !== 0) return relevanceDelta;
      }
      const freshnessDelta = compareSentimentHotFreshness(a, b);
      if (freshnessDelta !== 0) return freshnessDelta;
      const heatDelta = Number(b.hotScore || 0) - Number(a.hotScore || 0);
      if (heatDelta !== 0) return heatDelta;
      if (keywords.length > 0) {
        const aLow = isObviouslyLowQualitySentimentHotCandidate(a, keywords) ? 1 : 0;
        const bLow = isObviouslyLowQualitySentimentHotCandidate(b, keywords) ? 1 : 0;
        if (aLow !== bLow) return aLow - bLow;
      }
      return sentimentHotHanCount(b.content) - sentimentHotHanCount(a.content);
    })
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
  const relevanceNeedles = buildRelevanceNeedlesForMode(keywords, searchMode);
  const sorted = candidates
    .map((candidate) => candidateMeetsDisplayQuality(candidate, keywords, searchMode, options?.freshnessDays))
    .filter((candidate): candidate is SentimentHotCandidate => Boolean(candidate))
    .sort((a, b) => {
      if (searchMode === "strict" && relevanceNeedles.length > 0) {
        const relevanceDelta = countMatchedNeedles(b, relevanceNeedles) - countMatchedNeedles(a, relevanceNeedles);
        if (relevanceDelta !== 0) return relevanceDelta;
      }
      const freshnessDelta = compareSentimentHotFreshness(a, b);
      if (freshnessDelta !== 0) return freshnessDelta;
      const heatDelta = Number(b.hotScore || 0) - Number(a.hotScore || 0);
      if (heatDelta !== 0) return heatDelta;
      const aShown = shownIds.has(a.id) ? 1 : 0;
      const bShown = shownIds.has(b.id) ? 1 : 0;
      if (aShown !== bShown) return aShown - bShown;
      if (aShown && bShown) {
        const aShownAt = shownAtMap.get(a.id) || 0;
        const bShownAt = shownAtMap.get(b.id) || 0;
        if (aShownAt !== bShownAt) return aShownAt - bShownAt;
      }
      if (keywords.length > 0) {
        const aLow = isObviouslyLowQualitySentimentHotCandidate(a, keywords) ? 1 : 0;
        const bLow = isObviouslyLowQualitySentimentHotCandidate(b, keywords) ? 1 : 0;
        if (aLow !== bLow) return aLow - bLow;
      }
      return sentimentHotHanCount(b.content) - sentimentHotHanCount(a.content);
    });
  for (const candidate of sorted) {
    const content = cleanSentimentCandidateContent(candidate.content || "");
    if (!content) continue;
    if (options?.excludeShown && getSentimentHotCandidateHistoryKeys({ ...candidate, content }).some((key) => shownHistoryKeys.has(key))) continue;
    const keys = sentimentCandidateFinalDedupeKeys(candidate, content);
    if (keys.some((key) => seenKeys.has(key))) continue;
    keys.forEach((key) => seenKeys.add(key));
    out.push({ ...candidate, content });
    if (out.length >= limit) break;
  }
  return out;
}

function candidateLooksOffTopic(candidate: SentimentHotCandidate): boolean {
  const text = [candidate.content, candidate.author].map(cleanText).join(" ");
  const offTopicGroups = [
    /(?:日本自由行|心齋橋|心斋桥|大阪|京都|東京|东京|旅遊|旅游|飯店|酒店|民宿|機票|景點|景点|行程|住宿|免稅|免税)/u,
  ];
  return offTopicGroups.some((pattern) => pattern.test(text));
}

function countMatchedNeedles(candidate: SentimentHotCandidate, needles: string[]): number {
  const haystack = [
    candidate.content,
    candidate.author,
  ].map(cleanText).join(" ").toLowerCase();
  return needles.filter((needle) => haystack.includes(needle.toLowerCase())).length;
}

function candidateTouchesCurrentKeywords(candidate: SentimentHotCandidate, keywords: string[]): boolean {
  const needles = buildRelevanceNeedles(keywords);
  if (needles.length === 0) return false;
  return countMatchedNeedles(candidate, needles) > 0;
}

export function candidateMatchesCurrentKeywords(candidate: SentimentHotCandidate, keywords: string[], searchMode: SentimentHotSearchMode = "normal"): boolean {
  const needles = buildRelevanceNeedlesForMode(keywords, searchMode);
  if (needles.length === 0) return false;
  const strongNeedles = buildStrongRelevanceNeedlesForMode(keywords, searchMode);
  const matchedCount = countMatchedNeedles(candidate, needles);
  const matchedStrongCount = countMatchedNeedles(candidate, strongNeedles);
  if (matchedCount <= 0) return false;
  if (candidateLooksOffTopic(candidate) && countMatchedNeedles(candidate, buildDirectRelevanceNeedles(keywords)) < 1) return false;
  if (searchMode === "normal") return matchedCount >= 2;
  if (strongNeedles.length > 0 && matchedStrongCount <= 0 && matchedCount < 2) return false;

  return matchedStrongCount > 0 || matchedCount >= 2;
}

async function fetchThreadsSearchPageCandidates(args: {
  archiveId: string;
  keywords: string[];
  queryKeywords?: string[];
  limit: number;
  refresh?: boolean;
  searchMode?: SentimentHotSearchMode;
  deadlineAt?: number;
}): Promise<SentimentHotCandidate[]> {
  const baseQueries = args.queryKeywords?.length
    ? buildModelOrderedThreadsSearchQueries(args.queryKeywords)
    : buildThreadsSearchQueries(args.keywords);
  const shownIds = getSentimentHotShownIds(args.archiveId);
  const excluded = getSentimentHotRefreshExcludedIds(args.archiveId);
  const excludedHistoryKeys = getSentimentHotShownHistoryKeys(args.archiveId);
  const queries = buildOrderedSentimentQueries(
    baseQueries,
    shownIds.size + (args.refresh ? Math.floor(shownIds.size / Math.max(1, args.limit)) : 0),
    args.refresh === true,
  );
  if (queries.length === 0) return [];

  const byId = new Map<string, SentimentHotCandidate>();
  const dedupeKeys = new Set<string>();
  const addAll = (candidates: SentimentHotCandidate[]) => {
    for (const candidate of candidates) {
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
  const browserPromise = (!args.deadlineAt || sourceTimeoutMs >= 3_000)
    ? withSentimentTimeout(fetchThreadsBrowserSearchCandidates({
      archiveId: args.archiveId,
      keywords: args.keywords,
      queries: queries.slice(0, THREADS_BROWSER_QUERY_LIMIT),
      limit: sourceLimit,
      excludeIds: excluded,
      deadlineAt: args.deadlineAt
        ? Math.min(args.deadlineAt, Date.now() + SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS)
        : Date.now() + SENTIMENT_HOT_STAGE_BROWSER_TIMEOUT_MS,
      searchMode: args.searchMode,
    }).catch(() => []), sourceTimeoutMs, [])
    : Promise.resolve([]);
  const readerPromise = withSentimentTimeout(fetchThreadsReaderSearchCandidates({
      archiveId: args.archiveId,
      keywords: args.keywords,
      queries: queries.slice(0, THREADS_READER_INITIAL_QUERY_LIMIT),
      limit: sourceLimit,
      refresh: args.refresh,
      excludeIds: excluded,
      searchMode: args.searchMode,
      deadlineAt: args.deadlineAt,
    }).catch(() => []), sourceTimeoutMs, []);
  const [browserCandidates, readerCandidates] = await Promise.all([browserPromise, readerPromise]);
  addAll(browserCandidates);
  addAll(readerCandidates);

  if (byId.size < args.limit) {
    const remainingQueries = queries.slice(THREADS_READER_INITIAL_QUERY_LIMIT, THREADS_READER_TOTAL_QUERY_LIMIT);
    for (let offset = 0; offset < remainingQueries.length && byId.size < args.limit; offset += THREADS_READER_QUERY_BATCH_SIZE) {
      if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
      const extraTimeoutMs = Math.min(6_000, remainingSentimentDeadlineMs(args.deadlineAt, 6_000));
      const extraCandidates = await withSentimentTimeout(fetchThreadsReaderSearchCandidates({
        archiveId: args.archiveId,
        keywords: args.keywords,
        queries: remainingQueries.slice(offset, offset + THREADS_READER_QUERY_BATCH_SIZE),
        limit: sourceLimit - byId.size,
        refresh: args.refresh,
        excludeIds: excluded,
        searchMode: args.searchMode,
        deadlineAt: args.deadlineAt,
      }).catch(() => []), extraTimeoutMs, []);
      addAll(extraCandidates);
    }
  }

  if (byId.size < args.limit) {
    addAll(readThreadsSearchCandidateCache(
      args.archiveId,
      args.keywords,
      args.limit - byId.size,
      true,
      args.searchMode,
    ));
  }

  const sorted = sortSentimentHotCandidatePool([...byId.values()], args.keywords, args.limit, args.searchMode);
  if (sorted.length > 0) writeThreadsSearchCandidateCache(args.archiveId, args.keywords, sorted, args.searchMode);
  return sorted;
}

type ThreadsSearchGraphqlTemplate = {
  endpoint: string;
  method: string;
  params: Record<string, string>;
  variables: Record<string, any>;
  headers: Record<string, string>;
};

function threadsSearchVariableQuery(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:query|search_query|searchQuery)$/i.test(key) && typeof child === "string" && cleanText(child)) return cleanText(child);
    const nested = threadsSearchVariableQuery(child);
    if (nested) return nested;
  }
  return "";
}

function replaceThreadsSearchVariables(value: unknown, query: string, after?: string | null): any {
  if (Array.isArray(value)) return value.map((item) => replaceThreadsSearchVariables(item, query, after));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:query|search_query|searchQuery)$/i.test(key) && typeof child === "string") next[key] = query;
    else if (/^(?:after|cursor)$/i.test(key) && (child === null || typeof child === "string")) next[key] = after || null;
    else next[key] = replaceThreadsSearchVariables(child, query, after);
  }
  return next;
}

function extractThreadsGraphqlPostMedia(post: any): SentimentHotMedia[] {
  const media: SentimentHotMedia[] = [];
  const add = (urlValue: unknown, type: SentimentHotMedia["type"] = "image") => {
    const url = cleanText(urlValue);
    if (!/^https?:\/\//i.test(url) || isNonPostThreadsMediaUrl(url)) return;
    if (media.some((item) => item.url === url)) return;
    media.push({ type, url });
  };
  const addItem = (item: any) => {
    add(item?.image_versions2?.candidates?.[0]?.url || item?.display_url || item?.image_url, "image");
    add(item?.video_versions?.[0]?.url || item?.video_url, "video");
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
        const hotScore = likeCount + commentCount + repostCount + reshareCount;
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
  deadlineAt?: number;
}): Promise<any | null> {
  const params = new URLSearchParams(args.template.params);
  params.set("variables", JSON.stringify(replaceThreadsSearchVariables(args.template.variables, args.query, args.after)));
  const method = args.template.method === "GET" ? "GET" : "POST";
  const endpoint = method === "GET"
    ? `${args.template.endpoint.split("?")[0]}?${params.toString()}`
    : args.template.endpoint;
  const timeoutMs = Math.min(THREADS_BROWSER_REQUEST_TIMEOUT_MS, remainingSentimentDeadlineMs(args.deadlineAt, THREADS_BROWSER_REQUEST_TIMEOUT_MS));
  if (timeoutMs < 1_000) return null;
  const response = await args.page.evaluate(async ({ endpoint, method, body, headers, timeoutMs }: any) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fetch(endpoint || "/graphql/query", {
        method,
        credentials: "include",
        headers,
        body: method === "GET" ? undefined : body,
        signal: controller.signal,
      });
      return result.ok ? await result.text() : "";
    } catch {
      return "";
    } finally {
      clearTimeout(timeoutId);
    }
  }, { endpoint, method, body: params.toString(), headers: args.template.headers, timeoutMs });
  return safeJson(response);
}

async function fetchThreadsBrowserSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  excludeIds?: Set<string>;
  deadlineAt?: number;
  searchMode?: SentimentHotSearchMode;
}): Promise<SentimentHotCandidate[]> {
  const cookies = readSentimentBrowserAuthCookies("threads");
  const sessionCookieCount = cookies.filter((cookie: any) => String(cookie?.name || "").toLowerCase() === "sessionid" && String(cookie?.value || "").trim()).length;
  if (!hasValidThreadsSessionCookie(cookies)) {
    console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} sessionid=0 cookies=${cookies.length} status=skip_no_session`);
    return [];
  }
  console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} sessionid=${sessionCookieCount} cookies=${cookies.length} queries=${args.queries.length} status=start`);
  const excluded = args.excludeIds || getSentimentHotRefreshExcludedIds(args.archiveId);
  const excludedHistoryKeys = getSentimentHotShownHistoryKeys(args.archiveId);
  const results: SentimentHotCandidate[] = [];
  const resultKeys = new Set<string>();
  const stats = { pages: 1, queries: 0, graphql: 0, accepted: 0 };
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch(buildLocalChromiumLaunchOptions());
    try {
      const context = await browser.newContext({
        locale: "zh-TW",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      });
      await addCookiesBestEffort(context, cookies as any[]);
      const page = await context.newPage();
      let template: ThreadsSearchGraphqlTemplate | null = null;
      const captureTemplate = async (request: any) => {
        try {
          if (template || !/graphql\/query/i.test(String(request.url?.() || ""))) return;
          const requestUrl = new URL(String(request.url?.() || ""));
          const params = new URLSearchParams(String(request.postData?.() || "") || requestUrl.search);
          const friendlyName = cleanText(params.get("fb_api_req_friendly_name"));
          const variables = safeJson(params.get("variables") || "");
          if (!variables || typeof variables !== "object") return;
          const requestQuery = threadsSearchVariableQuery(variables);
          if (!/search/i.test(friendlyName) && !requestQuery) return;
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
          };
        } catch {
          // Continue waiting for the next search request.
        }
      };
      page.on("request", captureTemplate);
      const bootstrapQueries = [...new Set(args.queries.slice(0, THREADS_BROWSER_BOOTSTRAP_QUERY_LIMIT).filter(Boolean))];
      for (const bootstrapQuery of bootstrapQueries) {
        if (template || (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 3_000)) break;
        await page.goto(`https://www.threads.com/search?q=${encodeURIComponent(bootstrapQuery)}`, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(12_000, remainingSentimentDeadlineMs(args.deadlineAt, 12_000)),
        }).catch(() => undefined);
        for (let attempt = 0; !template && attempt < 6; attempt += 1) {
          if (args.deadlineAt && remainingSentimentDeadlineMs(args.deadlineAt, 0) < 2_000) break;
          await page.mouse.wheel(0, 2200).catch(() => undefined);
          await page.waitForTimeout(Math.min(600, remainingSentimentDeadlineMs(args.deadlineAt, 600))).catch(() => undefined);
        }
        const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        const postUrls = await page.$$eval('a[href*="/post/"]', (anchors: any[]) => anchors
          .map((anchor) => String(anchor.href || anchor.getAttribute?.("href") || "").trim())
          .filter(Boolean)).catch(() => []);
        const domCandidates = parseThreadsSearchTextCandidates({
          text: bodyText,
          query: bootstrapQuery,
          keywords: args.keywords,
          limit: Math.max(0, args.limit - results.length),
          sourceUrl: String(page.url?.() || `https://www.threads.com/search?q=${encodeURIComponent(bootstrapQuery)}`),
          sourceUrls: postUrls,
        });
        for (const candidate of domCandidates) {
          if (excluded.has(candidate.id)) continue;
          const normalized = candidateMeetsDisplayQuality(candidate, args.keywords, args.searchMode);
          if (!normalized) continue;
          const dedupeKey = sentimentCandidateDedupeKey(normalized);
          if (resultKeys.has(dedupeKey) || results.some((entry) => entry.id === normalized.id)) continue;
          results.push(normalized);
          resultKeys.add(dedupeKey);
          if (results.length >= args.limit) break;
        }
      }
      page.off("request", captureTemplate);

      if (template) {
        const shouldPageQueries = args.limit >= 40;
        const queries = args.queries.slice(0, shouldPageQueries ? Math.min(24, THREADS_BROWSER_QUERY_LIMIT) : THREADS_BROWSER_QUERY_LIMIT);
        const searchPages: any[] = [page];
        const requestedPageCount = Math.min(THREADS_BROWSER_PAGE_LIMIT, queries.length);
        if (requestedPageCount > 1 && (!args.deadlineAt || remainingSentimentDeadlineMs(args.deadlineAt, 0) >= 4_000)) {
          const extraPages = await Promise.all(Array.from({ length: requestedPageCount - 1 }, async (_, pageIndex) => {
            const extraPage = await context.newPage().catch(() => null);
            if (!extraPage) return null;
            const warmupQuery = queries[pageIndex + 1];
            await extraPage.goto(`https://www.threads.com/search?q=${encodeURIComponent(warmupQuery)}`, {
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
              payload: await requestThreadsGraphqlSearchPayload({ page: searchPage, template: template!, query, deadlineAt: args.deadlineAt }),
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
                  deadlineAt: args.deadlineAt,
                })
                : null;
              return { ...item, nextPayload };
            }));
            for (const item of payloadsWithNext) {
              const parsed = parseThreadsGraphqlSearchPayload({ payload: item.payload, query: item.query, keywords: args.keywords });
              stats.graphql += parsed.length;
              let accepted = 0;
              for (const candidate of parsed) {
                if (excluded.has(candidate.id)) continue;
                if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
                const normalized = candidateMeetsDisplayQuality(candidate, args.keywords, args.searchMode);
                if (!normalized) continue;
                const dedupeKey = sentimentCandidateDedupeKey(normalized);
                if (resultKeys.has(dedupeKey) || results.some((entry) => entry.id === normalized.id)) continue;
                results.push(normalized);
                resultKeys.add(dedupeKey);
                accepted += 1;
                stats.accepted += 1;
                if (results.length >= args.limit) break;
              }
              console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} page=${pageIndex + 1} query=${JSON.stringify(item.query)} graphql=${parsed.length} accepted=${accepted} total=${results.length}`);
              if (results.length < args.limit && item.nextPayload) {
                const nextParsed = parseThreadsGraphqlSearchPayload({ payload: item.nextPayload, query: item.query, keywords: args.keywords });
                stats.graphql += nextParsed.length;
                let nextAccepted = 0;
                for (const candidate of nextParsed) {
                  if (excluded.has(candidate.id)) continue;
                  if (getSentimentHotCandidateHistoryKeys(candidate).some((historyKey) => excludedHistoryKeys.has(historyKey))) continue;
                  const normalized = candidateMeetsDisplayQuality(candidate, args.keywords, args.searchMode);
                  if (!normalized) continue;
                  const dedupeKey = sentimentCandidateDedupeKey(normalized);
                  if (resultKeys.has(dedupeKey) || results.some((entry) => entry.id === normalized.id)) continue;
                  results.push(normalized);
                  resultKeys.add(dedupeKey);
                  nextAccepted += 1;
                  stats.accepted += 1;
                  if (results.length >= args.limit) break;
                }
                console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} page=${pageIndex + 1} query=${JSON.stringify(item.query)} page=2 graphql=${nextParsed.length} accepted=${nextAccepted} total=${results.length}`);
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
        console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=no_graphql_template`);
      }
      await context.close();
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=error message=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
    // Playwright is optional; reader/cache/database paths still keep the Telegram flow alive.
  }
  console.info(`[sentiment_hot_browser_search] archiveId=${args.archiveId} status=done total=${results.length} pages=${stats.pages} queries=${stats.queries} graphql=${stats.graphql} accepted=${stats.accepted}`);
  return sortSentimentHotCandidatePool(results, args.keywords, args.limit, args.searchMode);
}

const JINA_READER_PREFIX = "https://r.jina.ai/http://";

async function fetchThreadsReaderSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  refresh?: boolean;
  excludeIds?: Set<string>;
  searchMode?: SentimentHotSearchMode;
  deadlineAt?: number;
}): Promise<SentimentHotCandidate[]> {
  const excluded = args.excludeIds || (args.refresh ? getSentimentHotRefreshExcludedIds(args.archiveId) : getSentimentHotExcludedIds(args.archiveId));
  const all: SentimentHotCandidate[] = [];
  const allKeys = new Set<string>();
  const searches = await Promise.all(
    args.queries.map(async (query) => {
      const targetUrl = `https://www.threads.com/search?q=${encodeURIComponent(query)}`;
      try {
        const response = await fetch(`${JINA_READER_PREFIX}${targetUrl}`, {
          headers: {
            "user-agent": "Mozilla/5.0",
            accept: "text/plain, text/markdown, */*",
            "cache-control": "max-age=300",
          },
          signal: AbortSignal.timeout(Math.min(6_000, remainingSentimentDeadlineMs(args.deadlineAt, 6_000))),
        });
        if (!response.ok) return { query, targetUrl, text: "" };
        return { query, targetUrl, text: await response.text() };
      } catch {
        return { query, targetUrl, text: "" };
      }
    }),
  );
  for (const search of searches) {
    const parsed = parseThreadsReaderSearchMarkdownCandidates({
      text: search.text,
      query: search.query,
      keywords: args.keywords,
      sourceUrl: search.targetUrl,
      limit: Math.max(50, args.limit * 5),
    });
    for (const candidate of parsed) {
      if (excluded.has(candidate.id)) continue;
      const normalized = candidateMeetsDisplayQuality(candidate, args.keywords, args.searchMode);
      if (!normalized) continue;
      const dedupeKey = sentimentCandidateDedupeKey(normalized);
      if (all.some((item) => item.id === normalized.id) || allKeys.has(dedupeKey)) continue;
      allKeys.add(dedupeKey);
      all.push(normalized);
      if (all.length >= args.limit) break;
    }
    if (all.length >= args.limit) break;
  }
  return sortSentimentHotCandidatePool(all, args.keywords, args.limit, args.searchMode);
}

async function fetchInstagramReaderSearchCandidates(args: {
  archiveId: string;
  keywords: string[];
  queries: string[];
  limit: number;
  refresh?: boolean;
  excludeIds?: Set<string>;
}): Promise<SentimentHotCandidate[]> {
  const excluded = args.excludeIds || (args.refresh ? getSentimentHotRefreshExcludedIds(args.archiveId) : getSentimentHotExcludedIds(args.archiveId));
  const all: SentimentHotCandidate[] = [];
  const allKeys = new Set<string>();
  const searches = await Promise.all(
    args.queries.map(async (query) => {
      const normalizedQuery = cleanText(query).replace(/^#/, "");
      const targets = [
        `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(normalizedQuery)}`,
        hasHan(normalizedQuery) ? `https://www.instagram.com/explore/tags/${encodeURIComponent(normalizedQuery)}/` : "",
      ].filter(Boolean);
      const texts: Array<{ query: string; targetUrl: string; text: string }> = [];
      for (const targetUrl of targets) {
        try {
          const response = await fetch(`${JINA_READER_PREFIX}${targetUrl}`, {
            headers: {
              "user-agent": "Mozilla/5.0",
              accept: "text/plain, text/markdown, */*",
              "cache-control": "max-age=300",
            },
            signal: AbortSignal.timeout(8_000),
          });
          if (response.ok) texts.push({ query, targetUrl, text: await response.text() });
        } catch {
          // Instagram reader is an opportunistic extra source.
        }
      }
      return texts;
    }),
  );
  for (const search of searches.flat()) {
    const parsed = parseInstagramReaderSearchMarkdownCandidates({
      text: search.text,
      query: search.query,
      keywords: args.keywords,
      sourceUrl: search.targetUrl,
      limit: args.limit,
    });
    for (const candidate of parsed) {
      if (excluded.has(candidate.id)) continue;
      if (!candidateTouchesCurrentKeywords(candidate, args.keywords)) continue;
      const dedupeKey = sentimentCandidateDedupeKey(candidate);
      if (all.some((item) => item.id === candidate.id) || allKeys.has(dedupeKey)) continue;
      allKeys.add(dedupeKey);
      all.push(candidate);
      if (all.length >= args.limit) break;
    }
    if (all.length >= args.limit) break;
  }
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
    .replace(/Sorry,\s*we.{0,8}re having trouble playing this video\.\s*Learn more/gi, " ")
    .replace(/\bVideo\s+\d+\b/gi, " ")
    .split(/\r?\n/g)
    .map((line) => decodeMarkdownLinkText(line))
    .filter(Boolean)
    .filter((line) => !/^(?:Translate|翻譯|翻译)$/i.test(line))
    .filter((line) => !/^Sorry,\s*we.{0,8}re having trouble playing this video\.\s*Learn more$/i.test(line))
    .filter((line) => !/^Video\s+\d+$/i.test(line))
    .filter((line) => !/^\d+(?:[.,]\d+)?\s*[Kk萬万]?$/.test(line))
    .filter((line) => !/^Image\s+\d+/i.test(line));
  return cleanSentimentCandidateContent(lines.join(" "))
    .replace(/Sorry,\s*we.{0,8}re having trouble playing this video\.\s*Learn more/gi, " ")
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

export function parseThreadsGraphqlProfilePagePayload(args: {
  username: string;
  payload: any;
}): ThreadsGraphqlProfilePageResult {
  const mediaData = args.payload?.data?.mediaData;
  const edges = Array.isArray(mediaData?.edges) ? mediaData.edges : [];
  const posts: ThreadsGraphqlProfilePostAggregate[] = [];
  for (const edge of edges) {
    const post = edge?.node?.thread_items?.[0]?.post;
    if (!isThreadsGraphqlProfileOwnedPost(args.username, post)) continue;
    const pk = cleanText(post?.pk);
    const sourceUrl = buildThreadsGraphqlProfileSourceUrl(args.username, post);
    const content = cleanText(post?.caption?.text || post?.text_post_app_info?.share_text || post?.text_post_app_info?.text || "");
    const publishedAt = normalizeThreadsTimestamp(
      post?.taken_at
        ?? post?.taken_at_timestamp
        ?? post?.created_at
        ?? post?.caption?.created_at,
    );
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
  const text = await args.page.evaluate(async ({ body }) => {
    const response = await fetch("https://www.threads.com/graphql/query", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body,
    });
    return await response.text();
  }, { body: params.toString() });
  return safeJson(text);
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
}) {
  let stagnantRounds = 0;
  let lastGraphqlCount = args.capturedGraphqlPages.size;
  let lastVisibleKeyCount = 0;
  let lastScrollY = -1;
  const seenVisiblePostKeys = new Set<string>();
  for (let scroll = 0; scroll < (args.maxScrolls || 160); scroll += 1) {
    const reachedEnd = [...args.capturedGraphqlPages.values()].some(({ payload }) => {
      const pageResult = parseThreadsGraphqlProfilePagePayload({ username: args.username, payload });
      return pageResult.pageInfoResolved && pageResult.hasNextPage !== true;
    });
    if (reachedEnd) return;
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
    const scrollY = await args.page.evaluate(() => Math.round(window.scrollY || document.documentElement?.scrollTop || 0)).catch(() => -1);
    if (nextGraphqlCount === lastGraphqlCount
      && seenVisiblePostKeys.size <= lastVisibleKeyCount
      && Math.abs(scrollY - lastScrollY) < 40) {
      stagnantRounds += 1;
      if (stagnantRounds >= 12) return;
    } else {
      stagnantRounds = 0;
      lastGraphqlCount = nextGraphqlCount;
      lastVisibleKeyCount = seenVisiblePostKeys.size;
      lastScrollY = scrollY;
    }
  }
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

async function readThreadsViewCountFromPostPage(args: {
  page: any;
  sourceUrl: string;
}): Promise<number | undefined> {
  await args.page.goto(args.sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: 25_000,
  }).catch(() => null);
  await args.page.waitForFunction(() => {
    const text = String(document.body?.innerText || "");
    return /(\d+(?:[.,]\d+)?\s*(?:K|M|萬|万)?)\s*(次瀏覽|次浏览|瀏覽|浏览|views?)/i.test(text)
      || /回覆|回复|Replies?|尚無回覆|暂无回复/i.test(text);
  }, undefined, { timeout: 8_000 }).catch(() => null);
  const text = await args.page.locator("body").innerText({ timeout: 6_000 }).catch(() => "");
  return parseThreadsPostViewCountFromText(text);
}

async function collectThreadsViewCountsFromPostPages(args: {
  context: any;
  posts: ThreadsGraphqlProfilePostAggregate[];
}): Promise<{ totalViews: number; resolvedPosts: number; viewsByUrl: Record<string, number> }> {
  if (!args.posts.length) return { totalViews: 0, resolvedPosts: 0, viewsByUrl: {} };
  const workers = Math.min(4, args.posts.length);
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
  if (!process.env.VITEST_WORKER_ID) {
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
      await scrollThreadsProfileUntilGraphqlEnd({
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
  }
  if (process.env.THREADS_PROFILE_ALLOW_PARTIAL_READER === "1") {
  try {
    const readerTargetUrl = `${profileUrl}?__r=${Date.now().toString(36)}`;
    const response = await fetch(`${JINA_READER_PREFIX}${readerTargetUrl}`, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "text/plain, text/markdown, */*",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      signal: buildAbortSignalTimeout(15_000),
    });
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
  if (typeof likeCount === "number") engagement.likeCount = likeCount;
  if (typeof commentCount === "number") engagement.commentCount = commentCount;
  if (typeof viewCount === "number") engagement.viewCount = viewCount;
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
      ...(typeof viewCount === "number" ? { view_count: viewCount } : {}),
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
  return parseThreadsBrowserPostDetailMetrics({ text: detailText, actionTexts });
}

async function fetchThreadsBrowserDetailMetricsBatch(sourceUrls: string[], concurrency = 3) {
  if (process.env.VITEST_WORKER_ID) return null;
  const normalizedUrls = [...new Set(sourceUrls.map(normalizeThreadsPostUrl).filter(Boolean))];
  const results = new Map<string, Pick<ThreadsBrowserProfilePublishedPostSnapshot, "hotScore" | "engagement" | "metrics">>();
  if (!normalizedUrls.length) return results;
  const cookies = readSentimentBrowserAuthCookies("threads");
  if (!cookies.length) return results;
  let browser: any = null;
  let context: any = null;
  try {
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch(buildLocalChromiumLaunchOptions());
    context = await browser.newContext({
      viewport: { width: 900, height: 1400 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    await context.addCookies(cookies as any);
    let cursor = 0;
    const workerCount = Math.min(Math.max(1, concurrency), normalizedUrls.length);
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
    await context?.close?.().catch?.(() => null);
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
  if (/profile_pic|profile|s150x150/i.test(url)) return true;
  if (/\/favicon(?:[-_.]|\d|$)|favicon[_-]?\d*/i.test(url)) return true;
  if (/external-[^/]+\.xx\.fbcdn\.net\/emg1\/v\/t13\//i.test(url)) return true;
  return false;
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
    if (media.some((item) => item.url === url)) continue;
    const type = /\.(mp4|mov|webm)(?:$|[?#])/i.test(url) || /video/i.test(url) ? "video" : "image";
    media.push({ type, url });
    if (media.length >= limit) break;
  }
  return media;
}

function mergeCandidateMedia(base: SentimentHotMedia[], extra: SentimentHotMedia[]): SentimentHotMedia[] {
  const out: SentimentHotMedia[] = [];
  for (const item of [...base, ...extra]) {
    const url = String(item?.url || item?.localPath || "").trim();
    if (!url) continue;
    if (out.some((existing) => existing.url === item.url || (item.localPath && existing.localPath === item.localPath))) continue;
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
    const response = await fetch(`${JINA_READER_PREFIX}${readerTargetUrl}`, {
      headers: {
        "user-agent": "Mozilla/5.0",
        accept: "text/plain, text/markdown, */*",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      signal: buildAbortSignalTimeout(12_000),
    });
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

export async function enrichThreadsCandidateDetails(candidates: SentimentHotCandidate[], options: { force?: boolean } = {}): Promise<SentimentHotCandidate[]> {
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
    3,
  );
  await Promise.all(targets.map(async ({ candidate, index }) => {
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
    enriched[index] = {
      ...current,
      hotScore: Math.max(current.hotScore, detail.hotScore, realSentimentHotScore(engagement)),
      engagement,
      metrics: {
        ...(current.metrics || {}),
        ...(detail.metrics || {}),
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
  return undefined;
}

export function parseThreadsReaderSearchMarkdownCandidates(args: {
  text: string;
  query: string;
  keywords?: string[];
  limit?: number;
  sourceUrl: string;
}): SentimentHotCandidate[] {
  const text = String(args.text || "");
  if (!text || !/Search\s*•\s*Threads|Threads/i.test(text)) return [];
  const needleSource = [args.query, ...(args.keywords || [])].filter(Boolean);
  const needles = buildRelevanceNeedles(needleSource);
  const postRegex = /\[(\d{2}\/\d{2}\/\d{2,4})]\(((?:https?):\/\/www\.threads\.(?:net|com)\/(?:@[^)\s]+\/post\/[^)\s]+|t\/[^)\s]+))\)\s*\n([\s\S]*?)(?=\n\[!\[Image\s+\d+:[^\]]*profile picture|\n\[[^\]\n]+]\((?:https?):\/\/www\.threads\.(?:net|com)\/@|$)/g;
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
    if ((content.match(/[\u3400-\u9fff]/gu) || []).length < 12) continue;
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0) continue;
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
        ...compactEngagementMetrics(engagement),
      },
      engagement,
      publishedAt,
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
  limit?: number;
  sourceUrl: string;
}): SentimentHotCandidate[] {
  const text = String(args.text || "");
  if (!text || !/Instagram/i.test(text)) return [];
  const needleSource = [args.query, ...(args.keywords || [])].filter(Boolean);
  const needles = buildRelevanceNeedles(needleSource);
  const out: SentimentHotCandidate[] = [];
  const postMatches = [...text.matchAll(/https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/g)];
  const seenUrls = new Set<string>();
  for (const match of postMatches) {
    const sourceUrl = match[0].replace(/[)\].,]+$/g, "");
    if (seenUrls.has(sourceUrl)) continue;
    seenUrls.add(sourceUrl);
    const matchIndex = match.index || 0;
    const block = text.slice(Math.max(0, matchIndex - 900), Math.min(text.length, matchIndex + 1400));
    const authorMatches = [...block.matchAll(/\[([^\]\n@][^\]\n]{1,80})]\(https:\/\/www\.instagram\.com\/([^/)#?]+)\/?\)/g)]
      .filter((item) => isLikelyInstagramAuthor(item[2]));
    const author = cleanText(authorMatches.at(-1)?.[1] || authorMatches.at(-1)?.[2] || "Instagram");
    const content = cleanThreadsReaderContent(block
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[[^\]]*(?:profile picture|Image|圖像|图片)[^\]]*]\([^)]*\)/gi, " ")
      .replace(/https?:\/\/(?:[^/\s]+\.)?(?:cdninstagram|scontent|fbcdn)[^\s)]+/gi, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[A-Za-z0-9_./?&=%:-]{60,}/g, " ")
      .replace(/https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?/g, " ")
      .replace(/(?:Log in|Sign up|Explore|Search|Instagram)\s*/gi, " "));
    if (isLowQualitySentimentContent(content)) continue;
    if (!isChineseSentimentCandidate(content)) continue;
    if ((content.match(/[\u3400-\u9fff]/gu) || []).length < 12) continue;
    const haystack = [content, author].join(" ").toLowerCase();
    const matchedNeedles = needles.filter((needle) => haystack.includes(needle.toLowerCase()));
    if (needles.length && matchedNeedles.length === 0) continue;
    const engagement = mergeEngagementMetrics(
      extractInstagramEngagementMetricsFromText(block),
      extractEngagementMetricsFromText(block),
    );
    const media = extractThreadsMediaFromMarkdown(block, 12);
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
        ...compactEngagementMetrics(engagement),
      },
      engagement,
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
  const shardPath = threadsSearchCacheShardPath(archiveId, mode);
  migrateLegacyThreadsSearchCache();
  const written = withExclusiveJsonFileLock(shardPath, () => {
    const state = structuredClone(readThreadsSearchCacheFile(shardPath, true));
    const maxAgeMs = 24 * 60 * 60 * 1000;
    const now = new Date().toISOString();
    for (const key of threadsSearchCacheKeys(archiveId, keywords, searchMode)) {
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
      for (const candidate of candidates) add(candidate);
      if (canReuseExisting) {
        for (const candidate of existingRow.candidates || []) add(candidate);
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

function readThreadsSearchCandidateCache(archiveId: string, keywords: string[], limit: number, excludeShown = false, searchMode: SentimentHotSearchMode = "strict"): SentimentHotCandidate[] {
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
      if (!candidate?.id || excluded.has(candidate.id)) continue;
      const content = cleanThreadsReaderContent(candidate.content || "");
      const normalized = candidateMeetsDisplayQuality({
        ...candidate,
        content,
        warnings: uniqueSentimentWarnings([...(candidate.warnings || []), THREADS_SEARCH_CACHE_WARNING]),
      }, keywords, searchMode);
      if (!normalized) continue;
      byId.set(normalized.id, normalized);
    }
  }
  return sortSentimentHotCandidatePool([...byId.values()], keywords, limit, searchMode);
}

function isArchiveScopedFallbackCandidate(candidate: SentimentHotCandidate): boolean {
  return Boolean((candidate.metrics as any)?.archiveScopedFallback);
}

function readArchiveScopedThreadsSearchKeywords(archiveId: string, limit: number, searchMode: SentimentHotSearchMode): string[] {
  const state = readThreadsSearchCacheState(false, archiveId, searchMode);
  const scopedPrefix = `${cleanText(archiveId) || "default"}::${normalizeSentimentHotSearchMode(searchMode)}::`;
  const maxAgeMs = SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS;
  const keywords: string[] = [];
  const seen = new Set<string>();
  const archiveKeys = threadsSearchArchiveCacheKeys(state, archiveId, searchMode)
    .sort((a, b) => new Date(state[b]?.at || 0).getTime() - new Date(state[a]?.at || 0).getTime());
  for (const key of archiveKeys) {
    const row = state[key];
    if (!isCompatibleThreadsSearchCacheRow(row, maxAgeMs)) continue;
    const keyword = threadsSearchStoredKeyword(key, archiveId);
    if (!keyword || seen.has(keyword)) continue;
    const hasUsefulCandidate = (row.candidates || []).some((candidate) => {
      const content = cleanThreadsReaderContent(candidate?.content || "");
      return Boolean(
        candidate?.id
        && content
        && candidateMeetsDisplayQuality({
          ...candidate,
          content,
          metrics: {
            ...(candidate.metrics || {}),
            archiveScopedFallback: true,
          },
        }, [keyword], searchMode),
      );
    });
    if (!hasUsefulCandidate) continue;
    seen.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= limit) break;
  }
  return keywords;
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
      if (!candidate?.id || excluded.has(candidate.id) || byId.has(candidate.id)) continue;
      const content = cleanThreadsReaderContent(candidate.content || "");
      const normalized = candidateMeetsDisplayQuality({
        ...candidate,
        content,
        metrics: {
          ...(candidate.metrics || {}),
          archiveScopedFallback: true,
          archiveScopedKeyword: storedKeyword,
        },
      }, keywords, searchMode);
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

function readGlobalThreadsCandidateBackfill(
  archiveId: string,
  keywords: string[],
  limit: number,
  searchMode: SentimentHotSearchMode,
): SentimentHotCandidate[] {
  const state = readThreadsSearchCacheState();
  const excluded = getSentimentHotExcludedIds(archiveId);
  const byId = new Map<string, SentimentHotCandidate>();
  const candidateTarget = Math.max(limit * 3, 120);
  const scanLimit = Math.max(limit * 200, 8_000);
  const quickNeedles = meaningfulNeedles(keywords).map((term) => term.toLowerCase()).filter(Boolean);
  let scanned = 0;
  const rows = Object.values(state)
    .filter((row) => isCompatibleThreadsSearchCacheRow(row, SENTIMENT_HOT_ARCHIVE_BACKFILL_MAX_AGE_MS))
    .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
  for (const row of rows) {
    for (const candidate of row.candidates || []) {
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
    if (scanned > scanLimit || byId.size >= candidateTarget) break;
  }
  return sortSentimentHotCandidatePool([...byId.values()], keywords, limit, searchMode);
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
    const seedKeywords = archive ? buildSentimentHotKeywords({ archive }) : [];
    const sourceText = archive ? [archive.name, archive.content].map(cleanText).filter(Boolean).join(" ") : "";
    const strategy = archive ? readCachedSentimentHotSearchStrategy(buildSentimentHotSearchStrategyCacheKey({
      archive,
      personaText: "",
    })) : null;
    if (strategy && archive) {
      applyPersonaGuardToSentimentHotStrategy({
        strategy,
        archiveName: archive.name,
        personaSeedKeywords: buildSentimentHotKeywords({ archive: { name: archive.name } }),
        sourceText: cleanText(archive.name),
      });
    }
    for (const searchMode of ["normal", "strict"] as const) {
      const state = readThreadsSearchCacheState(false, archiveId, searchMode);
      const strategySource = strategy ? sentimentHotStrategyTermsForMode(strategy, searchMode) : seedKeywords;
      const keywords = prepareSentimentHotKeywordsForMode(strategySource, searchMode, {
        sourceText,
        useRuleDomainFallback: !strategy,
      });
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
        ? cachedCandidates.filter((candidate) => candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, searchMode))
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

function readManagedThreadsAccountCookies(): any[] {
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
        const cookieDbPath = path.join(cleanText(account?.profile_dir), "cookies.sqlite");
        if (!fs.existsSync(cookieDbPath)) continue;
        let cookieDb: any = null;
        try {
          cookieDb = new Database(cookieDbPath, { readonly: true, fileMustExist: true });
          const nowSeconds = Math.floor(Date.now() / 1000);
          const rows = cookieDb.prepare(`
            SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
            FROM moz_cookies
            WHERE lower(host) LIKE '%threads.%'
              AND (expiry = 0 OR expiry > ?)
          `).all(nowSeconds);
          const cookies = rows.map((row: any) => ({
            name: String(row.name || ""),
            value: String(row.value || ""),
            domain: String(row.host || ""),
            path: String(row.path || "/"),
            expires: Number(row.expiry || -1),
            httpOnly: Boolean(row.isHttpOnly),
            secure: Boolean(row.isSecure),
            sameSite: Number(row.sameSite) === 2 ? "Strict" : Number(row.sameSite) === 1 ? "Lax" : "None",
          }));
          if (hasValidThreadsSessionCookie(cookies)) {
            const cookieNames = new Set(cookies.map((cookie: any) => cleanText(cookie?.name).toLowerCase()).filter(Boolean));
            const cookieScore = cookieNames.size * 10 + cookies.length;
            if (cookieScore > bestCookieScore) {
              bestCookies = cookies;
              bestCookieScore = cookieScore;
            }
          }
        } catch {
          // Try the next ready account when a browser profile is locked or incomplete.
        } finally {
          cookieDb?.close?.();
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

function readSentimentBrowserAuthCookies(platform: SentimentHotPlatform) {
  try {
    const profile = readSentimentBrowserAuthProfilesConfig().find((item: any) => sentimentProfileMatchesPlatform(item, platform));
    const nowSeconds = Date.now() / 1000;
    const cookies = (Array.isArray(profile?.cookies) ? profile.cookies : [])
      .filter((cookie: any) => {
        const expires = Number(cookie?.expires);
        return cookie?.name && cookie?.value && (!Number.isFinite(expires) || expires <= 0 || expires > nowSeconds);
      })
      .map((cookie: any) => {
        const sameSite = ["Strict", "Lax", "None"].includes(cookie.sameSite) ? cookie.sameSite : undefined;
        return {
          name: String(cookie.name),
          value: String(cookie.value),
          domain: String(cookie.domain || profile.domain || "threads.net"),
          path: String(cookie.path || "/"),
          expires: Number.isFinite(Number(cookie.expires)) ? Number(cookie.expires) : -1,
          httpOnly: Boolean(cookie.httpOnly || cookie.http_only),
          secure: cookie.secure !== false,
          sameSite,
        };
      });
    if (platform !== "threads") return cookies;
    const managedCookies = readManagedThreadsAccountCookies();
    const mergedCookies = mergeBrowserAuthCookies(managedCookies, cookies);
    const mirrored = mergedCookies
      .filter((cookie: any) => cookieDomainMatchesAny(cookie, ["threads.net", "threads.com"]))
      .flatMap((cookie: any) => [
        { ...cookie, domain: ".threads.net" },
        { ...cookie, domain: ".threads.com" },
      ]);
    return mergeBrowserAuthCookies(mergedCookies, mirrored).slice(0, 120);
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

function buildModelOrderedThreadsSearchQueries(keywords: string[]): string[] {
  const out: string[] = [];
  const add = (value: string) => {
    const text = cleanText(value);
    if (!text || !isSearchableRelevanceTerm(text) || text.length > 14) return;
    if (!out.includes(text)) out.push(text);
  };
  const orderedKeywords = meaningfulNeedles(keywords);
  for (const keyword of orderedKeywords) add(keyword);
  for (const keyword of orderedKeywords) {
    for (const variant of expandSentimentSearchKeywordVariants(keyword)) add(variant);
  }
  for (const keyword of orderedKeywords) {
    for (const part of splitKeywords(keyword)) add(part);
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
  return !/^(?:threads|instagram|search|login|home|profile|www|net|com|t)$/i.test(text);
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
    if ((content.match(/[\u3400-\u9fff]/gu) || []).length < 18) continue;
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
      if (hotScore < MIN_SENTIMENT_HOT_SCORE) continue;
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
      .sort((a, b) => b.hotScore - a.hotScore || new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())
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
    const response = await fetch(primary.url, { signal: AbortSignal.timeout(15_000) });
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

export async function downloadCandidateMedia(candidate: SentimentHotCandidate, limit = Number.POSITIVE_INFINITY): Promise<SentimentHotMedia[]> {
  const media = (candidate.media || []).slice(0, limit);
  const downloaded: SentimentHotMedia[] = [];
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    if (item.localPath && fs.existsSync(item.localPath)) {
      downloaded.push(item);
      continue;
    }
    if (!/^https?:\/\//i.test(item.url)) {
      downloaded.push(item);
      continue;
    }
    try {
      const response = await fetch(item.url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        downloaded.push(item);
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!/^image\/|^video\//i.test(contentType)) {
        downloaded.push(item);
        continue;
      }
      const ext = extensionFromContentType(contentType, item.type);
      const mediaDir = path.dirname(resolveRuntimeFile(`sentiment-hot-media/${candidate.id}-${index + 1}${ext}`));
      fs.mkdirSync(mediaDir, { recursive: true });
      const localPath = path.join(mediaDir, `${candidate.id}-${index + 1}${ext}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      downloaded.push({ ...item, localPath, warning: undefined });
    } catch {
      downloaded.push(item);
    }
  }
  return downloaded;
}

function extensionFromContentType(contentType: string, type: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("mp4")) return ".mp4";
  return type === "video" ? ".mp4" : ".jpg";
}
