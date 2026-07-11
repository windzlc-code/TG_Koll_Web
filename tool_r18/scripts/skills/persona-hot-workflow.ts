import "@/runtime/node/browser-shim";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";
import { appendCustomPersonaArchivePost, loadPersonaArchive, updatePersonaArchivePostDraft } from "@/lib/persona-archives";
import {
  cleanSentimentCandidateContent,
  downloadCandidateMedia,
  fetchSentimentHotCandidates,
  prefetchSentimentHotCandidatePool,
  primeSentimentHotCandidatePool,
  refreshSentimentSourceMetrics,
} from "@/lib/sentiment-hot-importer";
import {
  rememberSentimentHotImported,
  rememberSentimentHotSelected,
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
  memorySummaries?: string[];
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
};

type PrimeHotCandidatesInput = {
  action: "prime-hot-candidates";
  archiveId: string;
  searchMode?: "normal" | "strict";
  limit?: number;
};

type PrefetchHotCandidatesInput = {
  action: "prefetch-hot-candidates";
  archiveId: string;
  searchMode?: "normal" | "strict";
  lowWatermark?: number;
  targetCount?: number;
};

type PersonaHotWorkflowInput = FetchHotCandidatesInput | ImportHotCandidatesInput | RefreshHotPostInput | PrimeHotCandidatesInput | PrefetchHotCandidatesInput;

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

async function fetchHotCandidates(input: FetchHotCandidatesInput) {
  const archive = await loadPersonaArchive(String(input.archiveId || "").trim());
  if (!archive) throw new Error("人设不存在。");
  const memorySummaries = Array.isArray(input.memorySummaries)
    ? input.memorySummaries.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const result = await fetchSentimentHotCandidates({
    archive,
    prompt: String(input.prompt || "").trim() || undefined,
    memorySummaries,
    limit: Math.max(1, Math.min(Number(input.limit || 10), 20)),
    refresh: input.refresh === true,
    searchMode: input.searchMode === "normal" ? "normal" : "strict",
  });
  return {
    ok: true,
    archiveId: archive.id,
    archiveName: archive.name,
    keywords: result.keywords,
    searchMode: result.searchMode,
    cookieStatuses: result.cookieStatuses,
    warnings: result.warnings,
    candidates: result.candidates,
  };
}

async function primeHotCandidates(input: PrimeHotCandidatesInput) {
  const archive = await loadPersonaArchive(String(input.archiveId || "").trim());
  if (!archive) throw new Error("人设不存在。");
  const result = await primeSentimentHotCandidatePool(
    archive,
    input.searchMode === "normal" ? "normal" : "strict",
    Math.max(1, Math.min(Number(input.limit || 10), 20)),
  );
  return { ok: result.ok, archiveId: archive.id, archiveName: archive.name, ...result };
}

async function prefetchHotCandidates(input: PrefetchHotCandidatesInput) {
  const archive = await loadPersonaArchive(String(input.archiveId || "").trim());
  if (!archive) throw new Error("人设不存在。");
  const result = await prefetchSentimentHotCandidatePool({
    archive,
    searchMode: input.searchMode === "normal" ? "normal" : "strict",
    lowWatermark: Math.max(1, Math.min(Number(input.lowWatermark || 10), 80)),
    targetCount: Math.max(1, Math.min(Number(input.targetCount || 50), 120)),
  });
  return { ok: result.ok, archiveId: archive.id, archiveName: archive.name, searchMode: input.searchMode === "normal" ? "normal" : "strict", ...result };
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
    rememberSentimentHotSelected(archive.id, candidate.id);
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

async function refreshHotPost(input: RefreshHotPostInput) {
  const archiveId = String(input.archiveId || "").trim();
  const postId = String(input.postId || "").trim();
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) throw new Error("人设不存在。");
  const post = archive.posts.find((item) => String(item.id || "") === postId);
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
  const updated = await updatePersonaArchivePostDraft(archiveId, postId, {
    sourceMetaPatch: {
      hotScore: refreshed.hotScore,
      metrics: { ...(sourceMeta.metrics || {}), ...(refreshed.metrics || {}) },
      engagement: { ...(sourceMeta.engagement || {}), ...(refreshed.engagement || {}) },
      capturedAt: new Date().toISOString(),
    },
  });
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
  if (input.action === "prime-hot-candidates") {
    await printJsonAndExit(await primeHotCandidates(input));
  }
  if (input.action === "prefetch-hot-candidates") {
    await printJsonAndExit(await prefetchHotCandidates(input));
  }
  if (input.action === "import-hot-candidates") {
    await printJsonAndExit(await importHotCandidates(input));
  }
  if (input.action === "refresh-hot-post") {
    await printJsonAndExit(await refreshHotPost(input));
  }
  await printJsonAndExit({ ok: false, error: "unsupported action" }, 1);
}

main().catch((error) => {
  void printJsonAndExit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
});
