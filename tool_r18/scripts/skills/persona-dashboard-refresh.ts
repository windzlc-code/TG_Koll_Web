import "@/runtime/node/browser-shim";
import { fetchThreadsProfileHotMetrics, getLiveSentimentBrowserAuthProfileBinding, refreshSentimentBrowserCookiesForPlatform } from "@/lib/sentiment-hot-importer";
import { listPersonaArchives } from "@/lib/persona-archives";
import { installNodePersonaArchiveBridge, updatePersonaArchiveThreadsHotMetrics } from "@/runtime/node/persona-archive-store";

installNodePersonaArchiveBridge();

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
  const auth = useRssHub ? { ok: true, message: "RSSHub 模式不需要浏览器 Cookie", profileKey: "rsshub" } : await getLiveSentimentBrowserAuthProfileBinding("threads").catch((error: any) => ({
    ok: false,
    message: error instanceof Error ? error.message : String(error || "unknown"),
  } as any));
  const results: any[] = [];

  for (const archive of targets) {
    const setup: any = archive.setup || {};
    const accounts = setup.accountManagement || {};
    const username = normalizeThreadsUsername(accounts?.threads?.handle);
    if (!username) {
      results.push({ archiveId: archive.id, name: archive.name, ok: false, skipped: true, message: "未绑定 Threads 用户名" });
      continue;
    }
    if (!auth.ok) {
      results.push({ archiveId: archive.id, name: archive.name, username, ok: false, message: auth.message || refreshAuth.message || "Threads 授权无效，请先在后台授权中心更新 Cookie" });
      continue;
    }
    try {
      const metrics: any = useRssHub
        ? await fetchThreadsProfileHotMetricsViaRssHub(username)
        : await fetchThreadsProfileHotMetrics(username);
      const key = hotMetricKey(username);
      const existingHotMetrics = setup.hotMetrics || {};
      const previousMetrics = existingHotMetrics[key] || {};
      const usable = hasUsableMetrics(metrics);
      const complete = useRssHub ? metrics.complete === true : isCompleteMetrics(metrics);
      const mergedPostMetrics = Array.isArray(metrics.postMetrics)
        ? mergePostMetrics(previousMetrics, metrics.postMetrics)
        : previousMetrics.postMetrics;
      const nextMetric = complete
        ? {
            ...previousMetrics,
            platform: "threads",
            username: metrics.username || username,
            method: metrics.method,
            feedUrl: metrics.feedUrl,
            followers: metrics.followers,
            following: metrics.following,
            recentViews: metrics.recentViews,
            posts: useRssHub ? mergedPostMetrics.length : metrics.posts,
            likes: metrics.likes,
            comments: metrics.comments,
            reposts: metrics.reposts,
            shares: metrics.shares,
            views: metrics.views,
            viewResolvedPosts: metrics.viewResolvedPosts,
            viewMissingPosts: metrics.viewMissingPosts,
            scannedPosts: useRssHub ? mergedPostMetrics.length : metrics.scannedPosts,
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
            method: metrics.method,
            feedUrl: metrics.feedUrl,
            complete: false,
            scope: metrics.scope,
            refreshedAt: metrics.refreshedAt,
            scannedPosts: metrics.scannedPosts,
            error: metrics.error || (usable ? "本次只读取到局部资料，未覆盖为完整热点数据。" : "未读取到可用热点数据。"),
          };
      const updatedAt = new Date().toISOString();
      const saved = updatePersonaArchiveThreadsHotMetrics({
        archiveId: archive.id,
        expectedHandle: username,
        metricKey: key,
        metric: nextMetric,
        authProfileKey: auth.profileKey,
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
        scannedPosts: metrics.scannedPosts || 0,
        postMetrics: Array.isArray(metrics.postMetrics) ? metrics.postMetrics.length : 0,
        message: complete ? "刷新完成" : nextMetric.error,
      });
    } catch (error: any) {
      results.push({ archiveId: archive.id, name: archive.name, username, ok: false, message: error instanceof Error ? error.message : String(error || "刷新失败") });
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
