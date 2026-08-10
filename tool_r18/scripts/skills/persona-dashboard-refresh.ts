import "@/runtime/node/browser-shim";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fetchInstagramProfileHotMetrics, fetchThreadsBrowserDetailMetricsBatch, fetchThreadsProfileHotMetrics, getLiveSentimentBrowserAuthProfileBinding, refreshSentimentBrowserCookiesForPlatform } from "@/lib/sentiment-hot-importer";
import { listPersonaArchives } from "@/lib/persona-archives";
import { installNodePersonaArchiveBridge, updatePersonaArchivePlatformHotMetrics, updatePersonaArchiveThreadsHotMetrics } from "@/runtime/node/persona-archive-store";

installNodePersonaArchiveBridge();

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function normalizeThreadsUsername(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?threads\.(?:net|com)\//i, "")
    .replace(/^@/, "")
    .split(/[/?#\s]/)[0]
    .trim();
}

function hotMetricKey(username: string): string {
  return `threads:${normalizeThreadsUsername(username).toLowerCase()}`;
}

function normalizeInstagramUsername(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#\s]/)[0]
    .trim();
}

function instagramHotMetricKey(username: string): string {
  return `instagram:${normalizeInstagramUsername(username).toLowerCase()}`;
}

type PersonaThreadsAccountBinding = {
  username: string;
  accountId?: string;
  archiveId?: string;
  profileDir?: string;
  status?: string;
  source?: "account_pool" | "legacy_binding";
};

function argValue(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function archiveIdsFromArgs(): string[] {
  const encoded = argValue("archive-ids-b64");
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("archive ids must be an array");
    return Array.from(new Set(parsed.map((item) => String(item || "").trim()).filter(Boolean)));
  } catch {
    throw new Error("invalid archive-ids-b64 argument");
  }
}

function resolveWebappDataDirs(): string[] {
  return Array.from(new Set([
    String(process.env.WEBAPP_DATA_DIR || "").trim(),
    "/data/webapp_data",
    path.resolve(process.cwd(), "..", "webapp_data"),
    path.resolve(process.cwd(), "webapp_data"),
  ].filter(Boolean)));
}

let cachedThreadsAccountPool: PersonaThreadsAccountBinding[] | null = null;
let cachedInstagramAccountPool: PersonaThreadsAccountBinding[] | null = null;

function readThreadsAccountPool(): PersonaThreadsAccountBinding[] {
  if (cachedThreadsAccountPool) return cachedThreadsAccountPool;
  const out: PersonaThreadsAccountBinding[] = [];
  for (const dataDir of resolveWebappDataDirs()) {
    const dbPath = path.join(dataDir, "app.db");
    if (!fs.existsSync(dbPath)) continue;
    let appDb: any = null;
    try {
      appDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = appDb.prepare(`
        SELECT id, persona_id, username, profile_dir, status
        FROM social_accounts
        WHERE lower(platform) = 'threads'
          AND lower(status) IN ('ready', 'active')
          AND trim(username) <> ''
        ORDER BY last_login_check_at DESC, updated_at DESC, created_at DESC
      `).all();
      for (const row of rows) {
        const username = normalizeThreadsUsername(row?.username);
        if (!username) continue;
        out.push({
          username,
          accountId: String(row?.id || "").trim() || undefined,
          archiveId: String(row?.persona_id || "").trim() || undefined,
          profileDir: String(row?.profile_dir || "").trim() || undefined,
          status: String(row?.status || "").trim() || undefined,
          source: "account_pool",
        } as PersonaThreadsAccountBinding & { archiveId?: string });
      }
    } catch {
      // Try the next known webapp data directory.
    } finally {
      appDb?.close?.();
    }
    if (out.length) break;
  }
  cachedThreadsAccountPool = out;
  return out;
}

function threadsAccountPoolBindingIsCurrent(archiveId: unknown, target: PersonaThreadsAccountBinding): boolean {
  if (target.source !== "account_pool") return true;
  cachedThreadsAccountPool = null;
  const expectedArchiveId = String(archiveId || "").trim();
  const expectedAccountId = String(target.accountId || "").trim();
  const expectedUsername = normalizeThreadsUsername(target.username).toLowerCase();
  return readThreadsAccountPool().some((binding) => (
    String(binding.archiveId || "").trim() === expectedArchiveId
    && (!expectedAccountId || String(binding.accountId || "").trim() === expectedAccountId)
    && normalizeThreadsUsername(binding.username).toLowerCase() === expectedUsername
  ));
}

function readInstagramAccountPool(): PersonaThreadsAccountBinding[] {
  if (cachedInstagramAccountPool) return cachedInstagramAccountPool;
  const out: PersonaThreadsAccountBinding[] = [];
  for (const dataDir of resolveWebappDataDirs()) {
    const dbPath = path.join(dataDir, "app.db");
    if (!fs.existsSync(dbPath)) continue;
    let appDb: any = null;
    try {
      appDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = appDb.prepare(`
        SELECT id, persona_id, username, profile_dir, status
        FROM social_accounts
        WHERE lower(platform) = 'instagram'
          AND lower(status) IN ('ready', 'active')
          AND trim(username) <> ''
        ORDER BY last_login_check_at DESC, updated_at DESC, created_at DESC
      `).all();
      for (const row of rows) {
        const username = normalizeInstagramUsername(row?.username);
        if (!username) continue;
        out.push({
          username,
          accountId: String(row?.id || "").trim() || undefined,
          archiveId: String(row?.persona_id || "").trim() || undefined,
          profileDir: String(row?.profile_dir || "").trim() || undefined,
          status: String(row?.status || "").trim() || undefined,
          source: "account_pool",
        } as PersonaThreadsAccountBinding & { archiveId?: string });
      }
    } catch {
      // Try the next known webapp data directory.
    } finally {
      appDb?.close?.();
    }
    if (out.length) break;
  }
  cachedInstagramAccountPool = out;
  return out;
}

function threadsHandleFromPostUrl(value: unknown): string {
  const text = String(value || "").trim();
  const match = text.match(/^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@([^/?#]+)\/post\/[^/?#]+/i);
  return normalizeThreadsUsername(match?.[1] || "");
}

function publishedThreadsUrlsFromRecord(record: any): string[] {
  if (!record || typeof record !== "object") return [];
  const publishedMeta = record.publishedMeta && typeof record.publishedMeta === "object" ? record.publishedMeta : {};
  const sourceMeta = record.sourceMeta && typeof record.sourceMeta === "object" ? record.sourceMeta : {};
  return [
    record.publishedUrl,
    record.published_url,
    record.postUrl,
    record.post_url,
    record.url,
    publishedMeta.publishedUrl,
    publishedMeta.postUrl,
    publishedMeta.url,
    sourceMeta.publishedUrl,
    sourceMeta.postUrl,
    sourceMeta.url,
  ].map(String).filter((item) => /^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[^/]+\/post\//i.test(item));
}

function normalizeThreadsPostUrl(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^https:\/\/www\.threads\.com\//i, "https://www.threads.net/")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function threadsPostCodeFromUrl(value: unknown): string {
  const match = normalizeThreadsPostUrl(value).match(/\/post\/([^/?#]+)/i);
  return String(match?.[1] || "").trim();
}

function publishedThreadsUrlsForHandle(archive: any, usernameInput: string): string[] {
  const username = normalizeThreadsUsername(usernameInput).toLowerCase();
  if (!username) return [];
  const out = new Set<string>();
  for (const record of Array.isArray(archive?.publishHistory) ? archive.publishHistory : []) {
    for (const url of publishedThreadsUrlsFromRecord(record)) {
      const handle = threadsHandleFromPostUrl(url).toLowerCase();
      if (handle !== username) continue;
      const normalized = normalizeThreadsPostUrl(url);
      if (normalized) out.add(normalized);
    }
  }
  return [...out.values()];
}

function collectThreadsRefreshTargets(archive: any): PersonaThreadsAccountBinding[] {
  const setup: any = archive?.setup || {};
  const accounts = setup.accountManagement || {};
  const currentLegacyHandle = normalizeThreadsUsername(accounts?.threads?.handle);
  const accountPool = readThreadsAccountPool();
  const currentBindings = (accountPool as Array<PersonaThreadsAccountBinding & { archiveId?: string }>)
    .filter((binding) => String(binding.archiveId || "").trim() === String(archive?.id || "").trim())
    .map((binding) => ({ ...binding, source: "account_pool" as const }));
  if (currentBindings.length) return currentBindings;
  return currentLegacyHandle ? [{ username: currentLegacyHandle, source: "legacy_binding" }] : [];
}

function collectInstagramRefreshTargets(archive: any): PersonaThreadsAccountBinding[] {
  const archiveId = String(archive?.id || "").trim();
  return readInstagramAccountPool().filter(
    (binding: PersonaThreadsAccountBinding & { archiveId?: string }) => String(binding.archiveId || "").trim() === archiveId,
  );
}

function publishedInstagramUrlsForTarget(archive: any, target: PersonaThreadsAccountBinding): string[] {
  const targetAccountId = String(target.accountId || "").trim();
  const targetUsername = normalizeInstagramUsername(target.username).toLowerCase();
  const out = new Set<string>();
  for (const record of Array.isArray(archive?.publishHistory) ? archive.publishHistory : []) {
    if (!record || typeof record !== "object") continue;
    const publishedMeta = record.publishedMeta && typeof record.publishedMeta === "object" ? record.publishedMeta : {};
    const sourceMeta = record.sourceMeta && typeof record.sourceMeta === "object" ? record.sourceMeta : {};
    const platform = String(record.platform || publishedMeta.platform || sourceMeta.platform || "").trim().toLowerCase();
    if (platform !== "instagram") continue;
    const recordAccountId = String(publishedMeta.accountId || sourceMeta.accountId || record.accountId || "").trim();
    const recordUsername = normalizeInstagramUsername(publishedMeta.username || sourceMeta.username || record.username).toLowerCase();
    if (targetAccountId && recordAccountId && targetAccountId !== recordAccountId) continue;
    if (!recordAccountId && targetUsername && recordUsername && targetUsername !== recordUsername) continue;
    for (const value of [
      record.publishedUrl,
      record.published_url,
      record.postUrl,
      record.post_url,
      publishedMeta.publishedUrl,
      publishedMeta.postUrl,
      sourceMeta.publishedUrl,
      sourceMeta.postUrl,
    ]) {
      const url = String(value || "").trim();
      if (/^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/[A-Za-z0-9_-]+/i.test(url)) out.add(url);
    }
  }
  return [...out.values()];
}

function decodeXml(value: string): string {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(value: string): string {
  return decodeXml(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstXml(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1] || "").trim() : "";
}

function xmlAttr(tag: string, attr: string): string {
  const match = tag.match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
  return match ? decodeXml(match[1] || "").trim() : "";
}

function mediaTypeFromUrl(url: string, fallback = ""): string {
  const text = `${url} ${fallback}`.toLowerCase();
  if (/(video|mp4|mov|m4v|webm)/.test(text)) return "video";
  if (/(image|photo|png|jpe?g|webp|gif)/.test(text)) return "image";
  return "unknown";
}

function extractRssHubItems(xml: string, username: string, capturedAt: string): any[] {
  const blocks = Array.from(String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)).map((match) => match[0]);
  return blocks.map((block, index) => {
    const title = stripHtml(firstXml(block, "title"));
    const description = stripHtml(firstXml(block, "description") || firstXml(block, "content:encoded"));
    const link = firstXml(block, "link") || firstXml(block, "guid");
    const publishedRaw = firstXml(block, "pubDate") || firstXml(block, "dc:date") || firstXml(block, "updated");
    const publishedAt = publishedRaw && !Number.isNaN(Date.parse(publishedRaw)) ? new Date(publishedRaw).toISOString() : undefined;
    const mediaItems: any[] = [];
    for (const mediaMatch of block.matchAll(/<(?:enclosure|media:content|media:thumbnail)\b[^>]*>/gi)) {
      const tag = mediaMatch[0] || "";
      const url = xmlAttr(tag, "url");
      if (!url) continue;
      const type = xmlAttr(tag, "type") || mediaTypeFromUrl(url);
      mediaItems.push({ url, type, label: `RSSHub 媒体 ${mediaItems.length + 1}` });
    }
    for (const imgMatch of block.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
      const url = decodeXml(imgMatch[1] || "").trim();
      if (url && !mediaItems.some((item) => item.url === url)) {
        mediaItems.push({ url, type: mediaTypeFromUrl(url, "image"), label: `RSSHub 图片 ${mediaItems.length + 1}` });
      }
    }
    return {
      id: firstXml(block, "guid") || link || `rsshub:${username}:${index}`,
      code: String(link || "").split("/post/")[1]?.split(/[?#/]/)[0],
      sourceUrl: link,
      content: description || title,
      originalContent: description || title,
      publishedAt,
      capturedAt,
      mediaItems,
      method: "rsshub",
    };
  }).filter((item) => item.sourceUrl || item.content);
}

function normalizePostMergeKey(post: any): string {
  const sourceUrl = String(post?.sourceUrl || post?.source_url || "").trim().toLowerCase();
  if (sourceUrl) return sourceUrl.replace(/[?#].*$/, "");
  const code = String(post?.code || "").trim().toLowerCase();
  if (code) return `code:${code}`;
  const id = String(post?.id || post?.pk || "").trim().toLowerCase();
  if (id) return `id:${id}`;
  const content = String(post?.content || post?.originalContent || post?.text || "").replace(/\s+/g, " ").trim().toLowerCase();
  return content ? `content:${content.slice(0, 180)}` : "";
}

function postSortTime(post: any): number {
  const raw = post?.publishedAt || post?.published_at || post?.capturedAt || post?.captured_at || "";
  const time = Date.parse(String(raw || ""));
  return Number.isFinite(time) ? time : 0;
}

function mergePostMetrics(previous: any, next: any[]): any[] {
  const previousRows = Array.isArray(previous?.postMetrics) ? previous.postMetrics : [];
  const merged = new Map<string, any>();
  for (const row of previousRows) {
    const key = normalizePostMergeKey(row);
    if (key) merged.set(key, row);
  }
  for (const row of next) {
    const key = normalizePostMergeKey(row);
    if (!key) continue;
    merged.set(key, { ...(merged.get(key) || {}), ...row });
  }
  return [...merged.values()]
    .sort((a, b) => postSortTime(b) - postSortTime(a))
    .slice(0, Number(process.env.PERSONA_DASHBOARD_MAX_POST_METRICS || 500));
}

function postMetricMatchesUrl(post: any, sourceUrl: string): boolean {
  const expectedUrl = normalizeThreadsPostUrl(sourceUrl).toLowerCase();
  const expectedCode = threadsPostCodeFromUrl(sourceUrl).toLowerCase();
  const actualUrl = normalizeThreadsPostUrl(post?.sourceUrl || post?.source_url).toLowerCase();
  const actualCode = String(post?.code || "").trim().toLowerCase();
  return Boolean(
    (expectedUrl && actualUrl && expectedUrl === actualUrl)
    || (expectedCode && actualCode && expectedCode === actualCode),
  );
}

async function backfillPublishedThreadsPostMetrics(args: {
  archive: any;
  username: string;
  postMetrics: any[];
  targetProfileDir?: string;
  capturedAt: string;
}): Promise<any[]> {
  const publishedUrls = publishedThreadsUrlsForHandle(args.archive, args.username);
  if (!publishedUrls.length) return args.postMetrics;
  const existingRows = Array.isArray(args.postMetrics) ? args.postMetrics : [];
  const missingUrls = publishedUrls.filter((url) => !existingRows.some((post) => {
    if (!postMetricMatchesUrl(post, url)) return false;
    const postViewCount = Number(post?.viewCount || 0);
    const postInteractions = [post?.likeCount, post?.commentCount, post?.repostCount, post?.shareCount]
      .reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
    return typeof post?.viewCount === "number"
      && (postViewCount > 0 || postInteractions === 0);
  }));
  if (!missingUrls.length) return existingRows;
  const previousProfileDir = process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR;
  try {
    const concurrency = Number(process.env.PERSONA_DASHBOARD_DETAIL_BACKFILL_CONCURRENCY || 2);
    const readWithProfileDir = async (urls: string[], profileDir?: string) => {
      if (profileDir) {
        process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR = profileDir;
      } else {
        delete process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR;
      }
      return await fetchThreadsBrowserDetailMetricsBatch(urls, concurrency).catch(() => null);
    };
    const detailRows = new Map<string, any>();
    const mergeDetails = (details: Map<string, any> | null | undefined) => {
      for (const [key, value] of details || []) {
        if (value && !detailRows.has(key)) detailRows.set(key, value);
      }
    };
    mergeDetails(await readWithProfileDir(missingUrls, args.targetProfileDir));
    let fallbackMissingUrls = missingUrls.filter((url) => !detailRows.has(normalizeThreadsPostUrl(url)));
    if (fallbackMissingUrls.length && args.targetProfileDir) {
      for (const binding of readThreadsAccountPool()) {
        const profileDir = String(binding.profileDir || "").trim();
        if (!profileDir || profileDir === args.targetProfileDir) continue;
        mergeDetails(await readWithProfileDir(fallbackMissingUrls, profileDir));
        fallbackMissingUrls = missingUrls.filter((url) => !detailRows.has(normalizeThreadsPostUrl(url)));
        if (!fallbackMissingUrls.length) break;
      }
    }
    const backfilled = missingUrls.flatMap((sourceUrl) => {
      const key = normalizeThreadsPostUrl(sourceUrl);
      const detail = detailRows.get(key);
      if (!detail) return [];
      const engagement = detail.engagement || {};
      const metrics = detail.metrics || {};
      return [{
        code: threadsPostCodeFromUrl(sourceUrl),
        sourceUrl: normalizeThreadsPostUrl(sourceUrl),
        likeCount: typeof engagement.likeCount === "number" ? engagement.likeCount : undefined,
        commentCount: typeof engagement.commentCount === "number" ? engagement.commentCount : undefined,
        repostCount: typeof metrics.repost_count === "number" ? metrics.repost_count : undefined,
        shareCount: typeof metrics.send_count === "number" ? metrics.send_count : undefined,
        viewCount: typeof engagement.viewCount === "number" ? engagement.viewCount : undefined,
        capturedAt: args.capturedAt,
        method: "browser_detail_backfill",
      }];
    });
    return backfilled.length ? mergePostMetrics({ postMetrics: existingRows }, backfilled) : existingRows;
  } finally {
    if (previousProfileDir) {
      process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR = previousProfileDir;
    } else {
      delete process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR;
    }
  }
}

async function fetchThreadsProfileHotMetricsViaRssHub(usernameInput: string): Promise<any> {
  const username = normalizeThreadsUsername(usernameInput);
  const refreshedAt = new Date().toISOString();
  const configuredBases = String(
    process.env.PERSONA_DASHBOARD_RSSHUB_BASE_URLS
    || process.env.RSSHUB_BASE_URL
    || process.env.PERSONA_DASHBOARD_RSSHUB_BASE_URL
    || "https://rsshub.rssforever.com,https://rsshub.app",
  );
  const bases = configuredBases.split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
  const routeTemplate = String(process.env.PERSONA_DASHBOARD_RSSHUB_THREADS_ROUTE || "/threads/{username}");
  const route = routeTemplate.replace("{username}", encodeURIComponent(username));
  const errors: string[] = [];
  for (const base of bases.length ? bases : ["https://rsshub.rssforever.com"]) {
    const url = `${base}${route.startsWith("/") ? route : `/${route}`}`;
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "application/rss+xml, application/xml, text/xml, */*",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        signal: AbortSignal.timeout(Number(process.env.PERSONA_DASHBOARD_RSSHUB_TIMEOUT_MS || 20000)),
      });
      const text = await response.text();
      if (!response.ok) {
        errors.push(`${url} -> ${response.status}: ${text.slice(0, 160)}`);
        continue;
      }
      const postMetrics = extractRssHubItems(text, username, refreshedAt);
      return {
        platform: "threads",
        username,
        posts: postMetrics.length,
        scannedPosts: postMetrics.length,
        postMetrics,
        likes: 0,
        comments: 0,
        reposts: 0,
        shares: 0,
        views: 0,
        viewResolvedPosts: 0,
        viewMissingPosts: postMetrics.length,
        complete: postMetrics.length > 0,
        scope: "rsshub_feed_monitor",
        method: "rsshub",
        feedUrl: url,
        refreshedAt,
        error: postMetrics.length ? undefined : "RSSHub 暂未返回该账号的帖子。",
      };
    } catch (error: any) {
      errors.push(`${url} -> ${error instanceof Error ? error.message : String(error || "unknown")}`);
    }
  }
  {
    return {
      platform: "threads",
      username,
      refreshedAt,
      method: "rsshub",
      complete: false,
      scope: "rsshub_failed",
      error: `RSSHub 全部实例不可用：${errors.join(" | ").slice(0, 800)}`,
    };
  }
}

function hasUsableMetrics(metrics: any): boolean {
  const scannedPosts = Number(metrics?.scannedPosts || 0);
  return scannedPosts > 0 || ["followers", "following", "recentViews", "posts", "likes", "comments", "reposts", "shares", "views"]
    .some((field) => typeof metrics?.[field] === "number");
}

function isCompleteMetrics(metrics: any): boolean {
  const scannedPosts = Number(metrics?.scannedPosts || 0);
  return metrics?.complete === true
    && metrics?.scope === "authenticated_full_profile"
    && scannedPosts > 0
    && Array.isArray(metrics?.postMetrics)
    && metrics.postMetrics.length >= scannedPosts;
}

function sentimentAuthStatusIsUsable(status: any): boolean {
  return ["healthy", "watch"].includes(String(status?.health || ""))
    && status?.hasRequiredSessionCookie !== false
    && status?.authorizationNeedsRefresh !== true;
}

async function main() {
  const targetId = argValue("archive-id");
  const scopedTargetIds = new Set([targetId, ...archiveIdsFromArgs()].filter(Boolean));
  const source = (argValue("source") || process.env.PERSONA_DASHBOARD_REFRESH_SOURCE || "browser").toLowerCase();
  const archives = await listPersonaArchives();
  const targets = scopedTargetIds.size
    ? archives.filter((archive) => scopedTargetIds.has(String(archive.id || "")))
    : archives;
  const useRssHub = source === "rsshub";
  const refreshAuth = useRssHub ? { ok: true, message: "RSSHub 模式不需要浏览器 Cookie" } : await refreshSentimentBrowserCookiesForPlatform("threads").catch((error: any) => ({
    ok: false,
    message: error instanceof Error ? error.message : String(error || "unknown"),
  }));
  const liveAuthStatus: any = useRssHub ? null : await getLiveSentimentBrowserAuthProfileBinding("threads").catch((error: any) => ({
    health: "missing",
    hasRequiredSessionCookie: false,
    authorizationNeedsRefresh: true,
    message: error instanceof Error ? error.message : String(error || "unknown"),
  }));
  const auth: any = useRssHub
    ? { ok: true, message: "RSSHub 模式不需要浏览器 Cookie", profileKey: "rsshub" }
    : {
        ...liveAuthStatus,
        ok: sentimentAuthStatusIsUsable(liveAuthStatus),
        profileKey: liveAuthStatus?.profileKey || "threads",
      };
  const results: any[] = [];

  for (const archive of targets) {
    const setup: any = archive.setup || {};
    const refreshTargets = collectThreadsRefreshTargets(archive);
    if (!refreshTargets.length) {
      results.push({ archiveId: archive.id, name: archive.name, ok: false, skipped: true, message: "未绑定可用 Threads 账号，请先在账号池绑定并确认账号已登录。" });
    }
    for (const target of refreshTargets) {
      const username = normalizeThreadsUsername(target.username);
      if (!username) continue;
      if (!auth.ok) {
        results.push({ archiveId: archive.id, name: archive.name, username, ok: false, message: auth.message || refreshAuth.message || "Threads 授权无效，请先在后台授权中心更新 Cookie" });
        continue;
      }
      try {
        const previousProfileDir = process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR;
        let metrics: any;
        try {
          if (target.profileDir) {
            process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR = target.profileDir;
          } else {
            delete process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR;
          }
          metrics = useRssHub
            ? await fetchThreadsProfileHotMetricsViaRssHub(username)
            : await fetchThreadsProfileHotMetrics(username);
        } finally {
          if (previousProfileDir) {
            process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR = previousProfileDir;
          } else {
            delete process.env.PERSONA_DASHBOARD_THREADS_PROFILE_DIR;
          }
        }
        const key = hotMetricKey(username);
        const existingHotMetrics = setup.hotMetrics || {};
        const previousMetrics = existingHotMetrics[key] || {};
        const usable = hasUsableMetrics(metrics);
        const complete = useRssHub ? metrics.complete === true : isCompleteMetrics(metrics);
        let mergedPostMetrics = Array.isArray(metrics.postMetrics)
          ? mergePostMetrics(previousMetrics, metrics.postMetrics)
          : Array.isArray(previousMetrics.postMetrics) ? previousMetrics.postMetrics : [];
        if (Array.isArray(mergedPostMetrics)) {
          mergedPostMetrics = await backfillPublishedThreadsPostMetrics({
            archive,
            username,
            postMetrics: mergedPostMetrics,
            targetProfileDir: target.profileDir,
            capturedAt: metrics.refreshedAt || new Date().toISOString(),
          });
        }
        const mergedRows = Array.isArray(mergedPostMetrics) ? mergedPostMetrics : [];
        const mergedResolvedViews = mergedRows.filter((post: any) => typeof post?.viewCount === "number").length;
        const mergedTotalViews = mergedRows.reduce((sum: number, post: any) => sum + (typeof post?.viewCount === "number" ? post.viewCount : 0), 0);
        const nextMetric = complete
          ? {
              ...previousMetrics,
              platform: "threads",
              username: metrics.username || username,
              accountId: target.accountId,
              targetSource: target.source,
              method: metrics.method,
              feedUrl: metrics.feedUrl,
              followers: metrics.followers,
              following: metrics.following,
              recentViews: metrics.recentViews,
              posts: useRssHub ? mergedRows.length : Math.max(Number(metrics.posts || 0), mergedRows.length),
              likes: metrics.likes,
              comments: metrics.comments,
              reposts: metrics.reposts,
              shares: metrics.shares,
              views: mergedResolvedViews > 0 ? mergedTotalViews : metrics.views,
              viewResolvedPosts: mergedResolvedViews,
              viewMissingPosts: Math.max(0, mergedRows.length - mergedResolvedViews),
              scannedPosts: useRssHub ? mergedRows.length : Math.max(Number(metrics.scannedPosts || 0), mergedRows.length),
              postMetrics: mergedPostMetrics,
              complete: true,
              scope: useRssHub ? "rsshub_feed_monitor" : "authenticated_full_profile",
              refreshedAt: metrics.refreshedAt,
              error: undefined,
            }
          : {
              ...previousMetrics,
              platform: "threads",
              username: metrics.username || username,
              accountId: target.accountId,
              targetSource: target.source,
              method: metrics.method,
              feedUrl: metrics.feedUrl,
              complete: false,
              scope: metrics.scope,
              refreshedAt: metrics.refreshedAt,
              posts: mergedRows.length ? Math.max(Number(metrics.posts || 0), mergedRows.length) : metrics.posts,
              scannedPosts: mergedRows.length ? Math.max(Number(metrics.scannedPosts || 0), mergedRows.length) : metrics.scannedPosts,
              ...(mergedRows.length ? {
                postMetrics: mergedPostMetrics,
                views: mergedResolvedViews > 0 ? mergedTotalViews : metrics.views,
                viewResolvedPosts: mergedResolvedViews,
                viewMissingPosts: Math.max(0, mergedRows.length - mergedResolvedViews),
              } : {}),
              error: metrics.error || (usable ? "本次只读取到局部资料，未覆盖为完整热点数据。" : "未读取到可用热点数据。"),
            };
        const updatedAt = new Date().toISOString();
        if (!threadsAccountPoolBindingIsCurrent(archive.id, target)) {
          results.push({
            archiveId: archive.id,
            name: archive.name,
            username,
            ok: false,
            skipped: true,
            message: "刷新期间 Threads 账号池绑定已变化，本次结果未写入。",
          });
          continue;
        }
        const saved = updatePersonaArchiveThreadsHotMetrics({
          archiveId: archive.id,
          expectedHandle: username,
          metricKey: key,
          metric: nextMetric,
          authProfileKey: auth.profileKey,
          replaceLegacyHandle: target.source === "account_pool",
          updatedAt,
        });
        if (!saved.ok) {
          results.push({
            archiveId: archive.id,
            name: archive.name,
            username,
            ok: false,
            skipped: true,
            message: saved.reason === "threads_binding_changed"
              ? "刷新期间 Threads 绑定已变化，本次结果未写入。"
              : "人设已不存在，本次结果未写入。",
          });
          continue;
        }
        results.push({
          archiveId: archive.id,
          name: archive.name,
          username,
          ok: complete,
          partial: !complete,
          targetSource: target.source,
          scannedPosts: metrics.scannedPosts || 0,
          postMetrics: Array.isArray(metrics.postMetrics) ? metrics.postMetrics.length : 0,
          message: complete ? "刷新完成" : nextMetric.error,
        });
      } catch (error: any) {
        results.push({ archiveId: archive.id, name: archive.name, username, ok: false, message: error instanceof Error ? error.message : String(error || "刷新失败") });
      }
    }

    if (!useRssHub) {
      const instagramTargets = collectInstagramRefreshTargets(archive);
      if (!instagramTargets.length) {
        results.push({ archiveId: archive.id, name: archive.name, platform: "instagram", ok: false, skipped: true, message: "未绑定可用 Instagram 账号，请先在账号池绑定并确认账号已登录。" });
      }
      for (const target of instagramTargets) {
        const username = normalizeInstagramUsername(target.username);
        if (!username) continue;
        try {
          const previousProfileDir = process.env.PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR;
          let metrics: any;
          try {
            if (target.profileDir) {
              process.env.PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR = target.profileDir;
            } else {
              delete process.env.PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR;
            }
            metrics = await fetchInstagramProfileHotMetrics(
              username,
              publishedInstagramUrlsForTarget(archive, target),
            );
          } finally {
            if (previousProfileDir) {
              process.env.PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR = previousProfileDir;
            } else {
              delete process.env.PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR;
            }
          }
          const usable = hasUsableMetrics(metrics);
          if (!usable) {
            results.push({
              archiveId: archive.id,
              name: archive.name,
              platform: "instagram",
              username,
              ok: false,
              message: metrics?.error || "Instagram 未读取到可用账号数据。",
            });
            continue;
          }
          const key = instagramHotMetricKey(username);
          const previousMetrics = setup?.hotMetrics?.[key] || {};
          const mergedPostMetrics = Array.isArray(metrics.postMetrics)
            ? mergePostMetrics(previousMetrics, metrics.postMetrics)
            : Array.isArray(previousMetrics.postMetrics) ? previousMetrics.postMetrics : [];
          const totalViews = mergedPostMetrics.reduce(
            (sum: number, post: any) => sum + (typeof post?.viewCount === "number" ? post.viewCount : 0),
            0,
          );
          const nextMetric = {
            ...previousMetrics,
            platform: "instagram",
            username: metrics.username || username,
            accountId: target.accountId,
            targetSource: target.source,
            method: metrics.method,
            ...(typeof metrics.followers === "number" ? { followers: metrics.followers } : {}),
            ...(typeof metrics.following === "number" ? { following: metrics.following } : {}),
            ...(typeof metrics.posts === "number" ? { posts: metrics.posts } : {}),
            ...(typeof metrics.likes === "number" ? { likes: metrics.likes } : {}),
            ...(typeof metrics.comments === "number" ? { comments: metrics.comments } : {}),
            ...(typeof metrics.reposts === "number" ? { reposts: metrics.reposts } : {}),
            ...(typeof metrics.shares === "number" ? { shares: metrics.shares } : {}),
            views: totalViews || Number(metrics.views || 0),
            scannedPosts: Number(metrics.scannedPosts || mergedPostMetrics.length),
            postMetrics: mergedPostMetrics,
            complete: metrics.complete === true,
            scope: metrics.scope,
            refreshedAt: metrics.refreshedAt,
            error: metrics.error,
          };
          const saved = updatePersonaArchivePlatformHotMetrics({
            archiveId: archive.id,
            metricKey: key,
            metric: nextMetric,
            updatedAt: new Date().toISOString(),
          });
          if (!saved.ok) {
            results.push({ archiveId: archive.id, name: archive.name, platform: "instagram", username, ok: false, skipped: true, message: "人设已不存在，本次 Instagram 结果未写入。" });
            continue;
          }
          results.push({
            archiveId: archive.id,
            name: archive.name,
            platform: "instagram",
            username,
            ok: true,
            partial: metrics.complete !== true,
            scannedPosts: Number(metrics.scannedPosts || 0),
            postMetrics: Array.isArray(metrics.postMetrics) ? metrics.postMetrics.length : 0,
            message: metrics.complete === true ? "Instagram 刷新完成" : metrics.error || "Instagram 近期数据已刷新。",
          });
        } catch (error: any) {
          results.push({ archiveId: archive.id, name: archive.name, platform: "instagram", username, ok: false, message: error instanceof Error ? error.message : String(error || "Instagram 刷新失败") });
        }
      }
    }
  }

  console.log(JSON.stringify({
    ok: results.some((item) => item.ok),
    refreshed: results.filter((item) => item.ok).length,
    partial: results.filter((item) => item.partial).length,
    skipped: results.filter((item) => item.skipped).length,
    total: results.length,
    auth: { ok: Boolean(auth.ok), message: auth.message || refreshAuth.message || "" },
    results,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error || "refresh failed") }));
    process.exit(1);
  });
