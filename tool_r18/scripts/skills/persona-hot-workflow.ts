import "@/runtime/node/browser-shim";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";
import { appendCustomPersonaArchivePost, listPersonaArchives, loadPersonaArchive, updatePersonaArchivePostDraft } from "@/lib/persona-archives";
import type { PersonaArchive, PersonaArchivePost } from "@/core/archives/persona-archive-domain";
import {
  cleanSentimentCandidateContent,
  downloadCandidateMedia,
  fetchSentimentHotCandidates,
  getSentimentHotGlobalPoolStat,
  listSentimentHotCandidatePoolStats,
  sentimentHotCandidatePoolLimits,
  prepareSentimentHotKeywords,
  refreshSentimentSourceMetrics,
  warmSentimentHotSearchStrategy,
} from "@/lib/sentiment-hot-importer";
import { stopSentimentRuntime } from "@/lib/sentiment-runtime-manager";
import {
  rememberSentimentHotImported,
  type SentimentHotCandidate,
  type SentimentHotMedia,
} from "@/lib/sentiment-candidate-store";

installNodePersonaArchiveBridge();

type FetchHotCandidatesInput = {
  action: "fetch-hot-candidates";
  archiveId: string;
  prompt?: string;
  limit?: number;
  refresh?: boolean;
  searchMode?: "normal" | "strict";
  writingLocale?: string;
  freshnessDays?: number;
  freshnessPolicy?: "legacy" | "strict";
  recordShown?: boolean;
  /** Test-only mode: count only candidates returned by this live search run. */
  liveOnly?: boolean;
  sourcePolicy?: "reader_first" | "reader_only" | "authenticated_only";
  memorySummaries?: string[];
  keywords?: string[];
  /** Authoritative control-plane snapshot. When present, never read the worker's archive copy. */
  archiveSnapshot?: PersonaArchive;
};

type PrepareHotKeywordsInput = {
  action: "prepare-hot-keywords";
  archiveId: string;
  prompt?: string;
  refresh?: boolean;
  forceRegenerate?: boolean;
  searchMode?: "normal" | "strict";
  writingLocale?: string;
  memorySummaries?: string[];
  /** Authoritative control-plane snapshot. When present, never read the worker's archive copy. */
  archiveSnapshot?: PersonaArchive;
};

type ImportHotCandidatesInput = {
  action: "import-hot-candidates";
  archiveId: string;
  candidates?: Array<Partial<SentimentHotCandidate>>;
};

type RefreshHotPostInput = {
  action: "refresh-hot-post";
  archiveId: string;
  postId: string;
  archiveSnapshot?: PersonaArchive;
  postSnapshot?: PersonaArchivePost;
  /** Worker mode returns a patch for the control plane and never persists locally. */
  outputOnly?: boolean;
  worker?: boolean;
  executionMode?: "local" | "worker";
};

type WarmHotStrategyInput = {
  action: "warm-hot-strategy";
  archiveId: string;
};

type PoolStatsInput = {
  action: "pool-stats";
  archiveIds?: string[];
};

type PersonaHotWorkflowInput = FetchHotCandidatesInput | PrepareHotKeywordsInput | ImportHotCandidatesInput | RefreshHotPostInput | WarmHotStrategyInput | PoolStatsInput;

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function printJsonAndExit(value: unknown, exitCode = 0): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  // A workflow CLI is short lived. Close the runtime it started before force
  // exiting so its background scanner cannot outlive this user request.
  stopSentimentRuntime();
  process.exit(exitCode);
}

function normalizeMediaItem(input: any): SentimentHotMedia | null {
  const url = String(input?.url || input?.localPath || "").trim();
  if (!url) return null;
  const type = ["image", "video", "unknown"].includes(String(input?.type || "").trim())
    ? (String(input?.type || "").trim() as "image" | "video" | "unknown")
    : "unknown";
  return {
    type,
    url,
    localPath: String(input?.localPath || "").trim() || undefined,
    warning: String(input?.warning || "").trim() || undefined,
  };
}

function normalizeCandidate(input: Partial<SentimentHotCandidate>, index = 0): SentimentHotCandidate {
  const raw = input as any;
  const rawMedia = Array.isArray(raw?.media) ? raw.media : Array.isArray(raw?.media_items) ? raw.media_items : [];
  const media = rawMedia.length
    ? rawMedia.map((item: any) => normalizeMediaItem(item)).filter((item: SentimentHotMedia | null): item is SentimentHotMedia => Boolean(item))
    : [];
  return {
    id: String(raw?.id || raw?.candidate_id || `hot-${index}`).trim(),
    platform: String(raw?.platform || "").trim() === "instagram" ? "instagram" : "threads",
    sourceUrl: String(raw?.sourceUrl || raw?.source_url || "").trim(),
    author: String(raw?.author || "").trim(),
    content: cleanSentimentCandidateContent(raw?.content || raw?.full_content || ""),
    media,
    hotScore: Number(raw?.hotScore ?? raw?.hot_score ?? 0),
    metrics: raw?.metrics && typeof raw.metrics === "object" ? raw.metrics : {},
    engagement: raw?.engagement && typeof raw.engagement === "object" ? raw.engagement : undefined,
    publishedAt: String(raw?.publishedAt || raw?.published_at || "").trim() || undefined,
    capturedAt: String(raw?.capturedAt || raw?.captured_at || "").trim() || new Date().toISOString(),
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.map((item: unknown) => String(item || "").trim()).filter(Boolean) : [],
    qaPassed: raw?.qaPassed === true || raw?.qa_passed === true,
  };
}

function resolveArchiveSnapshot(input: { archiveId: string; archiveSnapshot?: PersonaArchive }): PersonaArchive | undefined {
  if (input.archiveSnapshot === undefined || input.archiveSnapshot === null) return undefined;
  if (typeof input.archiveSnapshot !== "object" || Array.isArray(input.archiveSnapshot)) {
    throw new Error("archiveSnapshot must be an object.");
  }
  const archiveId = String(input.archiveId || "").trim();
  const snapshotId = String(input.archiveSnapshot.id || "").trim();
  if (!archiveId || snapshotId !== archiveId) {
    throw new Error("archiveSnapshot does not match archiveId.");
  }
  return input.archiveSnapshot;
}

async function resolvePersonaArchive(input: { archiveId: string; archiveSnapshot?: PersonaArchive }): Promise<PersonaArchive | null> {
  const snapshot = resolveArchiveSnapshot(input);
  if (snapshot) return snapshot;
  return loadPersonaArchive(String(input.archiveId || "").trim());
}

export async function fetchHotCandidates(input: FetchHotCandidatesInput) {
  const archive = await resolvePersonaArchive(input);
  if (!archive) throw new Error("人设不存在。");
  const memorySummaries = Array.isArray(input.memorySummaries)
    ? input.memorySummaries.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const result = await fetchSentimentHotCandidates({
    archive,
    prompt: String(input.prompt || "").trim() || undefined,
    memorySummaries,
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    limit: Math.max(1, Math.min(Number(input.limit || 10), 20)),
    refresh: input.refresh === true,
    searchMode: input.searchMode === "normal" ? "normal" : "strict",
    writingLocale: String(input.writingLocale || "").trim() || undefined,
    freshnessDays: input.freshnessDays,
    freshnessPolicy: input.freshnessPolicy === "strict" ? "strict" : "legacy",
    recordShown: input.recordShown !== false,
    liveOnly: input.liveOnly === true,
    sourcePolicy: input.sourcePolicy,
  } as Parameters<typeof fetchSentimentHotCandidates>[0]);
  return {
    ok: true,
    archiveId: archive.id,
    archiveName: archive.name,
    keywords: result.keywords,
    searchMode: result.searchMode,
    freshnessDays: result.freshnessDays,
    freshnessPolicy: result.freshnessPolicy,
    liveOnly: input.liveOnly === true,
    cookieStatuses: result.cookieStatuses,
    warnings: result.warnings,
    candidates: result.candidates,
  };
}

export async function prepareHotKeywords(input: PrepareHotKeywordsInput) {
  const archive = await resolvePersonaArchive(input);
  if (!archive) throw new Error("人设不存在。");
  const memorySummaries = Array.isArray(input.memorySummaries)
    ? input.memorySummaries.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const result = await prepareSentimentHotKeywords({
    archive,
    prompt: String(input.prompt || "").trim() || undefined,
    memorySummaries,
    searchMode: input.searchMode === "normal" ? "normal" : "strict",
    writingLocale: String(input.writingLocale || "").trim() || undefined,
    refresh: input.refresh === true,
    forceRegenerate: input.forceRegenerate === true,
  } as Parameters<typeof prepareSentimentHotKeywords>[0]);
  return {
    ok: true,
    archiveId: archive.id,
    archiveName: archive.name,
    keywords: result.keywords,
    searchMode: result.searchMode,
    warnings: result.warnings,
  };
}

async function warmHotStrategy(input: WarmHotStrategyInput) {
  const archive = await loadPersonaArchive(String(input.archiveId || "").trim());
  if (!archive) throw new Error("人设不存在。");
  return { ok: await warmSentimentHotSearchStrategy(archive), archiveId: archive.id, archiveName: archive.name };
}

async function appendCandidateAsPost(archiveId: string, candidate: SentimentHotCandidate, index: number) {
  const downloadedMedia = await downloadCandidateMedia(candidate).catch(() => candidate.media || []);
  const mediaItems = downloadedMedia
    .map((item) => ({
      url: item.localPath || item.url,
      type: item.type || "unknown",
      localPath: item.localPath,
      warning: item.warning,
    }))
    .filter((item) => item.url);
  const primaryMedia = mediaItems[0];
  const archive = await appendCustomPersonaArchivePost({
    archiveId,
    title: `热点 #${index + 1}`,
    content: cleanSentimentCandidateContent(candidate.content),
    mediaUrl: primaryMedia?.url || undefined,
    mediaType: primaryMedia?.type || undefined,
    mediaItems,
    sourceMeta: {
      source: "sentiment_hot_import",
      platform: candidate.platform,
      sourceUrl: candidate.sourceUrl,
      hotScore: candidate.hotScore,
      metrics: candidate.metrics,
      engagement: candidate.engagement,
      publishedAt: candidate.publishedAt,
      capturedAt: candidate.capturedAt,
      originalContent: cleanSentimentCandidateContent(candidate.content),
      originalMediaUrl: candidate.media[0]?.localPath || candidate.media[0]?.url,
      originalMediaUrls: candidate.media.map((item) => item.localPath || item.url).filter(Boolean),
      mediaItems,
      warnings: [
        ...(candidate.warnings || []),
        ...mediaItems.map((item) => item.warning).filter((item): item is string => Boolean(item)),
      ],
    },
  });
  const latestPost = archive?.posts?.[archive.posts.length - 1];
  return {
    id: String(latestPost?.id || "").trim(),
    title: String(latestPost?.title || "").trim(),
    content: String(latestPost?.content || "").trim(),
  };
}

async function importHotCandidates(input: ImportHotCandidatesInput) {
  const archive = await loadPersonaArchive(String(input.archiveId || "").trim());
  if (!archive) throw new Error("人设不存在。");
  const rawCandidates = Array.isArray(input.candidates) ? input.candidates : [];
  const candidates = rawCandidates.map((item, index) => normalizeCandidate(item, index)).filter((item) => item.sourceUrl || item.content);
  if (!candidates.length) throw new Error("请先选择至少一条热点候选。");
  const importedPosts: Array<{ id: string; title: string; content: string }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const post = await appendCandidateAsPost(archive.id, candidate, index);
    rememberSentimentHotImported(archive.id, candidate.id);
    importedPosts.push(post);
  }
  return {
    ok: true,
    archiveId: archive.id,
    importedCount: importedPosts.length,
    posts: importedPosts,
  };
}

function resolvePostSnapshot(input: RefreshHotPostInput, archive: PersonaArchive | null): PersonaArchivePost | undefined {
  if (input.postSnapshot !== undefined && input.postSnapshot !== null) {
    if (typeof input.postSnapshot !== "object" || Array.isArray(input.postSnapshot)) {
      throw new Error("postSnapshot must be an object.");
    }
    if (String(input.postSnapshot.id || "").trim() !== String(input.postId || "").trim()) {
      throw new Error("postSnapshot does not match postId.");
    }
    return input.postSnapshot;
  }
  return archive?.posts?.find((item) => String(item.id || "") === String(input.postId || "").trim());
}

export async function refreshHotPost(input: RefreshHotPostInput) {
  const archiveId = String(input.archiveId || "").trim();
  const postId = String(input.postId || "").trim();
  const archiveSnapshot = resolveArchiveSnapshot(input);
  const archive = archiveSnapshot
    || (input.postSnapshot ? ({ id: archiveId, posts: [input.postSnapshot] } as PersonaArchive) : await loadPersonaArchive(archiveId));
  if (!archive) throw new Error("人设不存在。");
  const post = resolvePostSnapshot(input, archive);
  if (!post) throw new Error("草稿不存在。");
  const sourceMeta = post.sourceMeta;
  if (sourceMeta?.source !== "sentiment_hot_import" || !String(sourceMeta.sourceUrl || "").trim()) {
    throw new Error("当前草稿不是可刷新的热点导入草稿。");
  }
  const refreshed = await refreshSentimentSourceMetrics({
    platform: sourceMeta.platform,
    sourceUrl: String(sourceMeta.sourceUrl),
    existingEngagement: sourceMeta.engagement as any,
    existingMedia: sourceMeta.mediaItems as any,
    existingHotScore: sourceMeta.hotScore,
  });
  if (!refreshed.ok) throw new Error(refreshed.message);
  const sourceMetaPatch = {
    hotScore: refreshed.hotScore,
    metrics: { ...(sourceMeta.metrics || {}), ...(refreshed.metrics || {}) },
    engagement: { ...(sourceMeta.engagement || {}), ...(refreshed.engagement || {}) },
    capturedAt: new Date().toISOString(),
  };
  const outputOnly = input.outputOnly === true
    || input.worker === true
    || input.executionMode === "worker"
    || Boolean(input.archiveSnapshot)
    || Boolean(input.postSnapshot);
  if (outputOnly) {
    return {
      ok: true,
      archiveId,
      postId,
      outputOnly: true,
      metricsPatch: { sourceMetaPatch },
    };
  }
  const updated = await updatePersonaArchivePostDraft(archiveId, postId, { sourceMetaPatch });
  if (!updated) throw new Error("热点数据已抓取，但草稿保存失败。");
  return { ok: true, archiveId, post: updated };
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    await printJsonAndExit({ ok: false, error: "missing JSON input" }, 1);
  }
  const input = JSON.parse(raw) as PersonaHotWorkflowInput;
  if (input.action === "fetch-hot-candidates") {
    await printJsonAndExit(await fetchHotCandidates(input));
  }
  if (input.action === "prepare-hot-keywords") {
    await printJsonAndExit(await prepareHotKeywords(input));
  }
  if (input.action === "warm-hot-strategy") {
    await printJsonAndExit(await warmHotStrategy(input));
  }
  if (input.action === "pool-stats") {
    const requestedIds = new Set((input.archiveIds || []).map((id) => String(id || "").trim()).filter(Boolean));
    const archives = (await listPersonaArchives()).filter((archive) => requestedIds.size === 0 || requestedIds.has(archive.id));
    const pools = requestedIds.size > 0 && archives.length === 0 ? [] : listSentimentHotCandidatePoolStats(archives);
    await printJsonAndExit({ ok: true, limits: sentimentHotCandidatePoolLimits(), pools, globalPool: getSentimentHotGlobalPoolStat() });
  }
  if (input.action === "import-hot-candidates") {
    await printJsonAndExit(await importHotCandidates(input));
  }
  if (input.action === "refresh-hot-post") {
    await printJsonAndExit(await refreshHotPost(input));
  }
  await printJsonAndExit({ ok: false, error: "unsupported action" }, 1);
}

const entryPath = String(process.argv[1] || "").trim();
const isMainModule = Boolean(entryPath) && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
if (isMainModule) {
  main().catch((error) => {
    void printJsonAndExit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
  });
}
