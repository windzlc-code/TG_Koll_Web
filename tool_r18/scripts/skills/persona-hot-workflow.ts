import "@/runtime/node/browser-shim";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";
import { appendCustomPersonaArchivePost, loadPersonaArchive } from "@/lib/persona-archives";
import {
  cleanSentimentCandidateContent,
  downloadCandidateMedia,
  fetchSentimentHotCandidates,
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

type PersonaHotWorkflowInput = FetchHotCandidatesInput | ImportHotCandidatesInput;

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
  const media = Array.isArray(input?.media)
    ? input.media.map((item) => normalizeMediaItem(item)).filter((item): item is SentimentHotMedia => Boolean(item))
    : [];
  return {
    id: String(input?.id || `hot-${index}`).trim(),
    platform: String(input?.platform || "").trim() === "instagram" ? "instagram" : "threads",
    sourceUrl: String(input?.sourceUrl || "").trim(),
    author: String(input?.author || "").trim(),
    content: cleanSentimentCandidateContent(input?.content || ""),
    media,
    hotScore: Number(input?.hotScore || 0),
    metrics: input?.metrics && typeof input.metrics === "object" ? input.metrics : {},
    engagement: input?.engagement && typeof input.engagement === "object" ? input.engagement : undefined,
    publishedAt: String(input?.publishedAt || "").trim() || undefined,
    capturedAt: String(input?.capturedAt || "").trim() || new Date().toISOString(),
    warnings: Array.isArray(input?.warnings) ? input.warnings.map((item) => String(item || "").trim()).filter(Boolean) : [],
    qaPassed: input?.qaPassed === true,
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

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    await printJsonAndExit({ ok: false, error: "missing JSON input" }, 1);
  }
  const input = JSON.parse(raw) as PersonaHotWorkflowInput;
  if (input.action === "fetch-hot-candidates") {
    await printJsonAndExit(await fetchHotCandidates(input));
  }
  if (input.action === "import-hot-candidates") {
    await printJsonAndExit(await importHotCandidates(input));
  }
  await printJsonAndExit({ ok: false, error: "unsupported action" }, 1);
}

main().catch((error) => {
  void printJsonAndExit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
});
