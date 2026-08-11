import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPersonaArchive: vi.fn(),
  updatePersonaArchivePostDraft: vi.fn(),
  fetchSentimentHotCandidates: vi.fn(),
  prepareSentimentHotKeywords: vi.fn(),
  refreshSentimentSourceMetrics: vi.fn(),
}));

vi.mock("@/runtime/node/browser-shim", () => ({}));
vi.mock("@/runtime/node/persona-archive-store", () => ({
  installNodePersonaArchiveBridge: vi.fn(),
}));
vi.mock("@/lib/persona-archives", () => ({
  appendCustomPersonaArchivePost: vi.fn(),
  listPersonaArchives: vi.fn(),
  loadPersonaArchive: mocks.loadPersonaArchive,
  updatePersonaArchivePostDraft: mocks.updatePersonaArchivePostDraft,
}));
vi.mock("@/lib/sentiment-hot-importer", () => ({
  cleanSentimentCandidateContent: (value: unknown) => String(value || "").trim(),
  downloadCandidateMedia: vi.fn(),
  fetchSentimentHotCandidates: mocks.fetchSentimentHotCandidates,
  listSentimentHotCandidatePoolStats: vi.fn(),
  prepareSentimentHotKeywords: mocks.prepareSentimentHotKeywords,
  refreshSentimentSourceMetrics: mocks.refreshSentimentSourceMetrics,
  warmSentimentHotSearchStrategy: vi.fn(),
}));
vi.mock("@/lib/sentiment-runtime-manager", () => ({ stopSentimentRuntime: vi.fn() }));
vi.mock("@/lib/sentiment-candidate-store", () => ({ rememberSentimentHotImported: vi.fn() }));

import {
  fetchHotCandidates,
  prepareHotKeywords,
  refreshHotPost,
} from "../../scripts/skills/persona-hot-workflow";

function archiveSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "persona-1",
    name: "Control-plane persona",
    content: "current persona",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T01:00:00.000Z",
    posts: [],
    ...overrides,
  } as any;
}

function hotPostSnapshot() {
  return {
    id: "post-1",
    title: "Hot post",
    content: "body",
    wordCount: 4,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    sourceMeta: {
      source: "sentiment_hot_import",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@tester/post/abc",
      hotScore: 10,
      metrics: { views: 100, likes: 2 },
      engagement: { likes: 2 },
    },
  } as any;
}

describe("persona hot workflow remote worker snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchSentimentHotCandidates.mockResolvedValue({
      keywords: ["current"],
      searchMode: "strict",
      freshnessDays: 7,
      freshnessPolicy: "legacy",
      cookieStatuses: [],
      warnings: [],
      candidates: [],
    });
    mocks.prepareSentimentHotKeywords.mockResolvedValue({
      keywords: ["current"],
      searchMode: "strict",
      warnings: [],
    });
    mocks.refreshSentimentSourceMetrics.mockResolvedValue({
      ok: true,
      hotScore: 25,
      metrics: { views: 150 },
      engagement: { replies: 3 },
    });
  });

  it("uses archiveSnapshot for candidate fetch without reading the worker archive", async () => {
    const snapshot = archiveSnapshot();

    const result = await fetchHotCandidates({
      action: "fetch-hot-candidates",
      archiveId: "persona-1",
      archiveSnapshot: snapshot,
      liveOnly: true,
      recordShown: false,
    });

    expect(mocks.loadPersonaArchive).not.toHaveBeenCalled();
    expect(mocks.fetchSentimentHotCandidates).toHaveBeenCalledWith(expect.objectContaining({ archive: snapshot }));
    expect(result.archiveName).toBe("Control-plane persona");
  });

  it("uses archiveSnapshot for keyword preparation without reading the worker archive", async () => {
    const snapshot = archiveSnapshot();

    await prepareHotKeywords({
      action: "prepare-hot-keywords",
      archiveId: "persona-1",
      archiveSnapshot: snapshot,
    });

    expect(mocks.loadPersonaArchive).not.toHaveBeenCalled();
    expect(mocks.prepareSentimentHotKeywords).toHaveBeenCalledWith(expect.objectContaining({ archive: snapshot }));
  });

  it("returns a merge patch and never persists when a postSnapshot is supplied", async () => {
    const result = await refreshHotPost({
      action: "refresh-hot-post",
      archiveId: "persona-1",
      postId: "post-1",
      postSnapshot: hotPostSnapshot(),
      outputOnly: true,
    });

    expect(mocks.loadPersonaArchive).not.toHaveBeenCalled();
    expect(mocks.updatePersonaArchivePostDraft).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      archiveId: "persona-1",
      postId: "post-1",
      outputOnly: true,
      metricsPatch: {
        sourceMetaPatch: {
          hotScore: 25,
          metrics: { views: 150, likes: 2 },
          engagement: { likes: 2, replies: 3 },
        },
      },
    });
  });

  it("treats any supplied archiveSnapshot as output-only even when the flag is omitted", async () => {
    const post = hotPostSnapshot();
    const result = await refreshHotPost({
      action: "refresh-hot-post",
      archiveId: "persona-1",
      postId: "post-1",
      archiveSnapshot: archiveSnapshot({ posts: [post] }),
    });

    expect(mocks.loadPersonaArchive).not.toHaveBeenCalled();
    expect(mocks.updatePersonaArchivePostDraft).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outputOnly: true, postId: "post-1" });
  });

  it("never persists in explicit outputOnly mode even when it must read the legacy archive", async () => {
    mocks.loadPersonaArchive.mockResolvedValue(archiveSnapshot({ posts: [hotPostSnapshot()] }));

    const result = await refreshHotPost({
      action: "refresh-hot-post",
      archiveId: "persona-1",
      postId: "post-1",
      outputOnly: true,
    });

    expect(mocks.loadPersonaArchive).toHaveBeenCalledWith("persona-1");
    expect(mocks.updatePersonaArchivePostDraft).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outputOnly: true, postId: "post-1" });
  });

  it("preserves the legacy local refresh contract when no snapshot or worker mode is supplied", async () => {
    const post = hotPostSnapshot();
    const updated = { ...post, sourceMeta: { ...post.sourceMeta, hotScore: 25 } };
    mocks.loadPersonaArchive.mockResolvedValue(archiveSnapshot({ posts: [post] }));
    mocks.updatePersonaArchivePostDraft.mockResolvedValue(updated);

    const result = await refreshHotPost({
      action: "refresh-hot-post",
      archiveId: "persona-1",
      postId: "post-1",
    });

    expect(mocks.loadPersonaArchive).toHaveBeenCalledWith("persona-1");
    expect(mocks.updatePersonaArchivePostDraft).toHaveBeenCalledWith(
      "persona-1",
      "post-1",
      expect.objectContaining({ sourceMetaPatch: expect.objectContaining({ hotScore: 25 }) }),
    );
    expect(result).toEqual({ ok: true, archiveId: "persona-1", post: updated });
  });

  it("rejects a snapshot for a different archive before doing any fetch", async () => {
    await expect(fetchHotCandidates({
      action: "fetch-hot-candidates",
      archiveId: "persona-1",
      archiveSnapshot: archiveSnapshot({ id: "persona-2" }),
    })).rejects.toThrow("archiveSnapshot does not match archiveId");

    expect(mocks.loadPersonaArchive).not.toHaveBeenCalled();
    expect(mocks.fetchSentimentHotCandidates).not.toHaveBeenCalled();
  });
});
