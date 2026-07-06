import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendEpisodesToArchive,
  appendCustomPersonaArchivePost,
  archivePostsToEpisodes,
  createPersonaArchive,
  deleteArchiveEpisode,
  deleteArchiveEpisodes,
  deletePersonaArchive,
  getCachedPersonaArchive,
  getCachedPersonaArchives,
  getArchivePendingPostsForPlatform,
  markArchiveEpisodesPublished,
  requeuePublishRecord,
  reorderArchivePosts,
  savePersonaArchive,
  updateArchiveEpisode,
  updateArchivePostMedia,
  updatePersonaArchivePadBinding,
  updatePersonaArchiveProfile,
} from "@/lib/persona-archives";
import { getPersonaMemory } from "@/lib/persona-memory";

describe("persona archives migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete (window as any).electronAPI;
    vi.restoreAllMocks();
  });

  it("appends a custom text post to an archive", async () => {
    const archive = await createPersonaArchive({
      id: "custom-text-post",
      name: "自定义推文测试",
      content: "测试人设",
      setup: { genres: ["测试"] } as any,
    });

    const saved = await appendCustomPersonaArchivePost({
      archiveId: archive.id,
      content: "今天只想发一条自己的内容",
    });

    expect(saved?.posts).toHaveLength(1);
    expect(saved?.posts[0].content).toBe("今天只想发一条自己的内容");
    expect(saved?.posts[0].wordCount).toBe("今天只想发一条自己的内容".length);
    expect(saved?.posts[0].imageUrl).toBeUndefined();
  });

  it("appends a custom media post and keeps the media URL for publishing", async () => {
    const archive = await createPersonaArchive({
      id: "custom-media-post",
      name: "自定义媒体推文测试",
      content: "测试人设",
      setup: { genres: ["测试"] } as any,
    });
    const mediaUrl = "https://example.test/custom-video.mp4";

    const saved = await appendCustomPersonaArchivePost({
      archiveId: archive.id,
      content: "这条要配视频发布",
      mediaUrl,
    });

    expect(saved?.posts).toHaveLength(1);
    expect(saved?.posts[0].content).toBe("这条要配视频发布");
    expect(saved?.posts[0].imageUrl).toBe(mediaUrl);
  });

  it("updates generated post media inside platform queues", async () => {
    const now = "2026-06-01T00:00:00.000Z";
    const post = {
      id: "post-with-platform-copy",
      title: "post #1",
      content: "content needing generated image",
      wordCount: 31,
      orderIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
    await savePersonaArchive({
      id: "platform-media-sync",
      name: "platform media sync",
      content: "persona",
      createdAt: now,
      updatedAt: now,
      posts: [{ ...post, imageUrl: "https://example.test/new-before-save.jpg" }],
      platformPosts: {
        threads: [{ ...post }],
        telegram: [{ ...post }],
      },
    } as any);

    const savedPost = await updateArchivePostMedia("platform-media-sync", post.id, {
      imageUrl: "https://example.test/generated.jpg",
      imageHistory: [{ imageUrl: "https://example.test/generated.jpg", createdAt: now, source: "generated-post-image" } as any],
      updatedAt: now,
    });
    const reloaded = getCachedPersonaArchive("platform-media-sync");

    expect(savedPost?.imageUrl).toBe("https://example.test/generated.jpg");
    expect(reloaded?.posts[0].imageUrl).toBe("https://example.test/generated.jpg");
    expect(reloaded?.platformPosts?.threads?.[0]?.imageUrl).toBe("https://example.test/generated.jpg");
    expect(reloaded?.platformPosts?.telegram?.[0]?.imageUrl).toBe("https://example.test/generated.jpg");
  });

  it("loads one archive without parsing the full archive array", () => {
    const archives = [
      {
        id: "fast-load-a",
        name: "不应完整解析 A",
        content: "A".repeat(2000),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        posts: [{ id: "a-post", content: "A post", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      },
      {
        id: "fast-load-b",
        name: "目标人设 B",
        content: "目标内容",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        setup: { genres: ["测试"], personaKey: "demo" },
        posts: [{ id: "b-post", content: "B post", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }],
      },
    ];
    window.localStorage.setItem("persona_archives_v2", JSON.stringify(archives));
    const parseSpy = vi.spyOn(JSON, "parse");

    const archive = getCachedPersonaArchive("fast-load-b");

    expect(archive?.id).toBe("fast-load-b");
    expect(archive?.name).toBe("目标人设 B");
    expect(archive?.posts).toHaveLength(1);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy.mock.calls[0]?.[0]).toContain("\"id\":\"fast-load-b\"");
    expect(parseSpy.mock.calls[0]?.[0]).not.toContain("\"id\":\"fast-load-a\"");
  });

  it("migrates legacy drama projects into persona archives", () => {
    window.localStorage.setItem(
      "storyforge_drama_projects",
      JSON.stringify([
        {
          id: "legacy-project",
          mode: "traditional",
          setup: {
            genres: ["育兒媽媽"],
            personaPersonality: "活潑開朗",
            personaGender: "女性",
            personaStyle: "故事化表達",
            totalEpisodes: 150,
            targetMarket: "cn",
          },
          creativePlan: "",
          characters: "舊專案人設",
          directory: [],
          directoryRaw: "",
          episodes: [
            {
              number: 1,
              title: "貼文 #1",
              content: "這是舊專案裡的推文",
              wordCount: 9,
            },
          ],
          complianceReport: "",
          currentStep: "export",
          dramaTitle: "舊專案檔案",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-03T00:00:00.000Z",
        },
      ]),
    );

    const archives = getCachedPersonaArchives();

    expect(archives).toHaveLength(1);
    expect(archives[0].id).toBe("legacy-project");
    expect(archives[0].name).toBe("舊專案檔案");
    expect(archives[0].posts).toHaveLength(1);
    expect(archives[0].posts[0].content).toBe("這是舊專案裡的推文");
  });

  it("deleting an archive also removes matching legacy sources", async () => {
    window.localStorage.setItem(
      "storyforge_drama_projects",
      JSON.stringify([
        {
          id: "legacy-project-delete",
          mode: "traditional",
          setup: {
            genres: ["育兒媽媽"],
            personaPersonality: "活潑開朗",
            personaGender: "女性",
            personaStyle: "故事化表達",
            totalEpisodes: 150,
            targetMarket: "cn",
          },
          creativePlan: "",
          characters: "舊專案人設",
          directory: [],
          directoryRaw: "",
          episodes: [
            {
              number: 1,
              title: "貼文 #1",
              content: "待刪除舊專案推文",
              wordCount: 8,
            },
          ],
          complianceReport: "",
          currentStep: "export",
          dramaTitle: "待刪除舊專案檔案",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-03T00:00:00.000Z",
        },
      ]),
    );

    expect(getCachedPersonaArchives()).toHaveLength(1);

    await deletePersonaArchive("legacy-project-delete");

    expect(getCachedPersonaArchives()).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem("storyforge_drama_projects") || "[]")).toHaveLength(0);
  });

  it("deleting an archive also removes its persona memory", async () => {
    const archive = await createPersonaArchive({
      id: "archive-with-memory",
      name: "帶記憶人設",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "這條發布內容會先進入記憶，然後跟隨人設刪除。",
      wordCount: 22,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);
    await markArchiveEpisodesPublished(archive.id, [episode.archivePostId!]);
    expect(getPersonaMemory(archive.id).entries).toHaveLength(1);

    await deletePersonaArchive(archive.id);

    expect(getCachedPersonaArchives().some((item) => item.id === archive.id)).toBe(false);
    expect(getPersonaMemory(archive.id).entries).toHaveLength(0);
  });

  it("moves published posts out of the archive and stores only memory outlines", async () => {
    const archive = await createPersonaArchive({
      id: "publish-retention",
      name: "發布記憶測試",
      content: "測試人設",
    });
    const episodes = Array.from({ length: 8 }, (_, index) => ({
      number: index + 1,
      title: `貼文 #${index + 1}`,
      content: `第${index + 1}條發布主題。這裡是發布後的主要觀點，需要進入摘要。後面這段完整原文細節不應該在記憶裡長期逐字保留，${"具體細節".repeat(30)}。`,
      wordCount: 170,
      createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

    const savedEpisodes = await appendEpisodesToArchive(archive.id, episodes);
    const ids = savedEpisodes.map((episode) => episode.archivePostId!).filter(Boolean);
    const published = await markArchiveEpisodesPublished(archive.id, ids);

    expect(published?.posts).toHaveLength(0);
    expect(getCachedPersonaArchives()[0].posts).toHaveLength(0);
    expect(getPersonaMemory(archive.id).entries).toHaveLength(8);
    expect(getPersonaMemory(archive.id).entries[0].summary.length).toBeLessThanOrEqual(183);
    expect(getPersonaMemory(archive.id).entries[0].summary).toContain("發布主題");
    expect(getPersonaMemory(archive.id).entries[0].summary).toContain("主要觀點");
    expect(getPersonaMemory(archive.id).entries[0].summary).not.toContain("具體細節具體細節具體細節");
  });

  it("stores granular memory summaries with concrete key points from published tweets", async () => {
    const archive = await createPersonaArchive({
      id: "publish-granular-memory",
      name: "細顆粒記憶測試",
      content: "理財人設",
    });
    const content = "最近看到專家對 2026 年中產資產配置的建議，我超有感觸！現在一個便當隨便都要破百，健保費可能又要調，生活成本根本回不去了。如果你還在猶豫要不要開始做理財規劃，我只能說：現在就是最好的時機。與其去研究那些聽不懂的複雜產品，不如先把現金流、保險缺口、緊急預備金整理好。";
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content,
      wordCount: content.length,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);

    await markArchiveEpisodesPublished(archive.id, [episode.archivePostId!]);
    const [memory] = getPersonaMemory(archive.id).entries;

    expect(memory.summary).toContain("中產資產配置");
    expect(memory.summary).toMatch(/生活成本|健保費|便當/);
    expect(memory.summary).toMatch(/現金流|保險缺口|緊急預備金/);
    expect(memory.summary).not.toBe("最近看到專家對 2026 年中產資產配置的建議，我超有感觸");
  });

  it("normalizes legacy published originals into summaries without retaining full text", async () => {
    const fullOriginal = `這是一條已經發布的完整原文。它會從舊存檔遷移進摘要欄位。${"這裡是舊版保留的逐字細節".repeat(20)}。`;

    await savePersonaArchive({
      id: "legacy-published-original",
      name: "舊發布原文清理",
      content: "測試人設",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      posts: [{
        id: "post-published",
        title: "貼文 #1",
        content: fullOriginal,
        wordCount: fullOriginal.length,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        publishedAt: "2026-05-03T00:00:00.000Z",
        publishedOriginal: fullOriginal,
      } as any],
    });

    const [post] = getCachedPersonaArchives()[0].posts;

    expect((post as any).publishedOriginal).toBeUndefined();
    expect(post.publishedMemory).toBe(post.content);
    expect(post.content.length).toBeLessThanOrEqual(183);
    expect(post.content).not.toContain("舊版保留的逐字細節舊版保留的逐字細節");
    expect(post.wordCount).toBe(post.content.length);
  });

  it("stores edited publish-panel content in memory before removing the archive post", async () => {
    const archive = await createPersonaArchive({
      id: "publish-edited-content",
      name: "編輯發布測試",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "原始歸檔正文",
      wordCount: 6,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);
    const archivePostId = episode.archivePostId!;

    const published = await markArchiveEpisodesPublished(archive.id, [archivePostId], {
      [archivePostId]: "發布面板編輯後的正文",
    });

    expect(published?.posts).toHaveLength(0);
    expect(getPersonaMemory(archive.id).entries.some((entry) => entry.summary.includes("發布面板編輯後的正文"))).toBe(true);
  });

  it("saves publish history before slow Electron memory writes finish", async () => {
    const archive = await createPersonaArchive({
      id: "publish-fast-archive-save",
      name: "發布快速落檔測試",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "這條推文需要先進發布紀錄，再慢慢補記憶。",
      wordCount: 20,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);

    let resolveAddEntry: (() => void) | undefined;
    let addEntryResolved = false;
    (window as any).electronAPI = {
      memory: {
        addEntry: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveAddEntry = () => {
                addEntryResolved = true;
                resolve({ ok: true });
              };
            }),
        ),
      },
    };

    const published = await markArchiveEpisodesPublished(archive.id, [episode.archivePostId!]);

    expect(published?.posts).toHaveLength(0);
    expect(published?.publishHistory).toHaveLength(1);
    expect(getCachedPersonaArchives()[0].publishHistory).toHaveLength(1);
    expect(addEntryResolved).toBe(false);

    resolveAddEntry?.();
    await Promise.resolve();
    delete (window as any).electronAPI;
  });

  it("stores full publish history with platform and device metadata", async () => {
    const archive = await createPersonaArchive({
      id: "publish-history-meta",
      name: "發布紀錄測試",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "原始正文",
      wordCount: 4,
      createdAt: "2026-05-01T00:00:00.000Z",
      imageUrl: "https://example.com/source.jpg",
    }]);
    const archivePostId = episode.archivePostId!;
    const fullSentContent = `發布時編輯後的完整正文。${"這裡是發布紀錄需要保留的完整細節".repeat(12)}。`;

    const published = await markArchiveEpisodesPublished(
      archive.id,
      [archivePostId],
      { [archivePostId]: fullSentContent },
      {
        [archivePostId]: {
          platform: "threads",
          padCode: "APP5B54EKW6UA8LS",
          padName: "APP5",
          mediaUrl: "https://example.com/published.jpg",
        },
      },
    );

    expect(published?.posts).toHaveLength(0);
    expect(published?.publishHistory).toHaveLength(1);
    expect(published?.publishHistory?.[0]).toMatchObject({
      archivePostId,
      content: fullSentContent,
      platform: "threads",
      padCode: "APP5B54EKW6UA8LS",
      padName: "APP5",
      imageUrl: "https://example.com/published.jpg",
    });
    expect(published?.publishHistory?.[0].publishedAt).toBeTruthy();
    expect(getCachedPersonaArchives()[0].publishHistory?.[0].content).toBe(fullSentContent);
    expect(getPersonaMemory(archive.id).entries[0].summary).not.toContain("發布紀錄需要保留的完整細節發布紀錄需要保留的完整細節");
  });

  it("keeps sentiment source metrics in publish history and requeued posts", async () => {
    const archive = await createPersonaArchive({
      id: "publish-history-source-meta",
      name: "source meta publish history",
      content: "test persona",
    });
    const withPost = await appendCustomPersonaArchivePost({
      archiveId: archive.id,
      content: "published from sentiment source",
      sourceMeta: {
        source: "sentiment_hot_import",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@example/post/abc",
        hotScore: 1234,
        engagement: { likeCount: 12, commentCount: 3, viewCount: 1234 },
        metrics: { like_count: 12, comment_count: 3, view_count: 1234 },
      },
    });
    const postId = withPost?.posts[0].id!;

    const published = await markArchiveEpisodesPublished(archive.id, [postId], {
      [postId]: "published from sentiment source",
    }, {
      [postId]: {
        platform: "threads",
        padCode: "PAD-1",
        publishedUrl: "https://www.threads.net/@mine/post/new",
        publishedMeta: {
          source: "published_post",
          platform: "threads",
          sourceUrl: "https://www.threads.net/@mine/post/new",
          hotScore: 50,
          engagement: { likeCount: 5, commentCount: 1, viewCount: 50 },
          metrics: { like_count: 5, comment_count: 1, view_count: 50 },
        },
        publishedTargets: [
          {
            platform: "threads",
            padCode: "PAD-1",
            publishedUrl: "https://www.threads.net/@mine/post/new",
            publishedMeta: {
              source: "published_post",
              platform: "threads",
              sourceUrl: "https://www.threads.net/@mine/post/new",
              hotScore: 50,
              engagement: { likeCount: 5, commentCount: 1, viewCount: 50 },
              metrics: { like_count: 5, comment_count: 1, view_count: 50 },
            },
          },
          {
            platform: "threads",
            padCode: "PAD-2",
            publishedUrl: "https://www.threads.net/@mine/post/new2",
            publishedMeta: {
              source: "published_post",
              platform: "threads",
              sourceUrl: "https://www.threads.net/@mine/post/new2",
              hotScore: 70,
              engagement: { likeCount: 7, commentCount: 2, viewCount: 70 },
              metrics: { like_count: 7, comment_count: 2, view_count: 70 },
            },
          },
        ],
      },
    });

    expect(published?.publishHistory?.[0].sourceMeta).toMatchObject({
      source: "sentiment_hot_import",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@example/post/abc",
      hotScore: 1234,
    });
    expect(published?.publishHistory?.[0].publishedUrl).toBe("https://www.threads.net/@mine/post/new");
    expect(published?.publishHistory?.[0].publishedMeta).toMatchObject({
      source: "published_post",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@mine/post/new",
      hotScore: 50,
    });
    expect(published?.publishHistory?.[0].publishedTargets).toHaveLength(2);
    expect(published?.publishHistory?.[0].publishedTargets?.[1]).toMatchObject({
      padCode: "PAD-2",
      publishedUrl: "https://www.threads.net/@mine/post/new2",
    });

    const recordId = published?.publishHistory?.[0].id!;
    const requeued = await requeuePublishRecord(archive.id, recordId);
    expect(requeued?.posts[0].sourceMeta).toMatchObject({
      source: "sentiment_hot_import",
      sourceUrl: "https://www.threads.net/@example/post/abc",
      hotScore: 1234,
    });
  });

  it("keeps platform publish queues independent after one platform publishes", async () => {
    const archive = await createPersonaArchive({
      id: "platform-independent-queues",
      name: "平台獨立待發測試",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "同一篇內容要分別發到 Threads 和 Telegram。",
      wordCount: 24,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);
    const postId = episode.archivePostId!;

    const afterThreads = await markArchiveEpisodesPublished(
      archive.id,
      [postId],
      { [postId]: "Threads 實際發出的內容" },
      { [postId]: { platform: "threads", padCode: "PAD-A" } },
    );

    expect(getArchivePendingPostsForPlatform(afterThreads, "threads")).toHaveLength(0);
    expect(getArchivePendingPostsForPlatform(afterThreads, "telegram")).toHaveLength(1);
    expect(getArchivePendingPostsForPlatform(afterThreads, "telegram")[0].id).toBe(postId);
    expect(afterThreads?.publishHistory).toHaveLength(1);
    expect(afterThreads?.publishHistory?.[0].platform).toBe("threads");

    const afterTelegram = await markArchiveEpisodesPublished(
      archive.id,
      [postId],
      { [postId]: "Telegram 實際發出的內容" },
      { [postId]: { platform: "telegram", padCode: "PAD-A" } },
    );

    expect(getArchivePendingPostsForPlatform(afterTelegram, "threads")).toHaveLength(0);
    expect(getArchivePendingPostsForPlatform(afterTelegram, "telegram")).toHaveLength(0);
    expect(afterTelegram?.publishHistory?.map((record) => record.platform).sort()).toEqual(["telegram", "threads"]);
  });

  it("can copy a published history record back into the publish queue", async () => {
    const archive = await createPersonaArchive({
      id: "publish-history-requeue",
      name: "歷史重發測試",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "原始正文",
      wordCount: 4,
      createdAt: "2026-05-01T00:00:00.000Z",
      imageUrl: "https://example.com/source.jpg",
    }]);
    const archivePostId = episode.archivePostId!;
    const fullSentContent = "這是一條已經發過、現在需要重新加入佇列的完整正文。";
    const published = await markArchiveEpisodesPublished(
      archive.id,
      [archivePostId],
      { [archivePostId]: fullSentContent },
      {
        [archivePostId]: {
          platform: "threads",
          padCode: "APP5B54EKW6UA8LS",
          imageUrl: "https://example.com/published.jpg",
        },
      },
    );
    const recordId = published?.publishHistory?.[0].id;

    const requeued = await requeuePublishRecord(archive.id, recordId!);

    expect(requeued?.publishHistory).toHaveLength(1);
    expect(requeued?.posts).toHaveLength(1);
    expect(requeued?.posts[0]).toMatchObject({
      content: fullSentContent,
      imageUrl: "https://example.com/published.jpg",
      orderIndex: 0,
    });
    expect(requeued?.posts[0].publishedAt).toBeUndefined();
    expect(requeued?.posts[0].id).not.toBe(archivePostId);
    expect(getCachedPersonaArchives()[0].posts[0].content).toBe(fullSentContent);
  });

  it("stores and clears the default device binding per persona archive", async () => {
    const archive = await createPersonaArchive({
      id: "pad-binding-persona",
      name: "设备绑定测试",
      content: "測試人設",
    });

    const bound = await updatePersonaArchivePadBinding(archive.id, {
      padCode: "APP5B54EKW6UA8LS",
      padName: "APP5",
    });

    expect(bound?.boundPadCode).toBe("APP5B54EKW6UA8LS");
    expect(bound?.boundPadName).toBe("APP5");
    expect(getCachedPersonaArchives()[0].boundPadCode).toBe("APP5B54EKW6UA8LS");

    const cleared = await updatePersonaArchivePadBinding(archive.id, {});

    expect(cleared?.boundPadCode).toBeUndefined();
    expect(cleared?.boundPadName).toBeUndefined();
  });

  it("updates persona name and prompt without clearing posts or pad binding", async () => {
    const archive = await createPersonaArchive({
      id: "persona-prompt-edit",
      name: "提示詞編輯測試",
      content: "舊提示詞",
      setup: {
        genres: ["理財專家"],
        personaPersonality: "知性優雅",
        personaGender: "女性",
        personaStyle: "實用內容分享",
        totalEpisodes: 150,
        targetMarket: "cn",
        setupMode: "topic",
        chineseScript: "traditional",
        personaName: "提示詞編輯測試",
      },
    });
    await updatePersonaArchivePadBinding(archive.id, {
      padCode: "APP5B54EKW6UA8LS",
      padName: "APP5",
    });
    await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "待發布推文",
      wordCount: 5,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);

    const updated = await updatePersonaArchiveProfile(archive.id, {
      name: "改名後的人設",
      content: "編輯後的新人設提示詞",
    });

    expect(updated?.name).toBe("改名後的人設");
    expect(updated?.content).toBe("編輯後的新人設提示詞");
    expect(updated?.setup?.personaName).toBe("改名後的人設");
    expect(updated?.boundPadCode).toBe("APP5B54EKW6UA8LS");
    expect(updated?.posts).toHaveLength(1);
    expect(getCachedPersonaArchives()[0].name).toBe("改名後的人設");
    expect(getCachedPersonaArchives()[0].setup?.personaName).toBe("改名後的人設");
    expect(getCachedPersonaArchives()[0].content).toBe("編輯後的新人設提示詞");
  });

  it("persists publish queue order independently from created time", async () => {
    const archive = await createPersonaArchive({
      id: "queue-order-edit",
      name: "佇列排序測試",
      content: "測試人設",
    });
    const episodes = await appendEpisodesToArchive(archive.id, [
      {
        number: 1,
        title: "貼文 #1",
        content: "第一條",
        wordCount: 3,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      {
        number: 2,
        title: "貼文 #2",
        content: "第二條",
        wordCount: 3,
        createdAt: "2026-05-02T00:00:00.000Z",
      },
      {
        number: 3,
        title: "貼文 #3",
        content: "第三條",
        wordCount: 3,
        createdAt: "2026-05-03T00:00:00.000Z",
      },
    ]);

    const reordered = await reorderArchivePosts(archive.id, [
      episodes[2].archivePostId!,
      episodes[0].archivePostId!,
      episodes[1].archivePostId!,
    ]);

    expect(reordered?.posts.map((post) => post.content)).toEqual(["第三條", "第一條", "第二條"]);
    expect(archivePostsToEpisodes(reordered!.posts).map((episode) => episode.content)).toEqual(["第三條", "第一條", "第二條"]);
    expect(reordered?.posts.map((post) => post.orderIndex)).toEqual([0, 1, 2]);
  });

  it("removes a draft post from the publish queue without creating history or memory", async () => {
    const archive = await createPersonaArchive({
      id: "queue-delete-post",
      name: "佇列刪除測試",
      content: "測試人設",
    });
    const episodes = await appendEpisodesToArchive(archive.id, [
      {
        number: 1,
        title: "貼文 #1",
        content: "第一條待發布",
        wordCount: 6,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      {
        number: 2,
        title: "貼文 #2",
        content: "第二條要刪除",
        wordCount: 6,
        createdAt: "2026-05-02T00:00:00.000Z",
      },
    ]);

    const deleted = await deleteArchiveEpisode(archive.id, episodes[1].archivePostId!);

    expect(deleted?.posts.map((post) => post.content)).toEqual(["第一條待發布"]);
    expect(deleted?.publishHistory || []).toHaveLength(0);
    expect(getPersonaMemory(archive.id).entries).toHaveLength(0);
    expect(getCachedPersonaArchives()[0].posts.map((post) => post.content)).toEqual(["第一條待發布"]);
  });

  it("removes multiple draft posts from the publish queue in one operation", async () => {
    const archive = await createPersonaArchive({
      id: "queue-delete-posts",
      name: "批量刪除測試",
      content: "測試人設",
    });
    const episodes = await appendEpisodesToArchive(archive.id, [
      {
        number: 1,
        title: "貼文 #1",
        content: "第一條保留",
        wordCount: 5,
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      {
        number: 2,
        title: "貼文 #2",
        content: "第二條刪除",
        wordCount: 5,
        createdAt: "2026-05-02T00:00:00.000Z",
      },
      {
        number: 3,
        title: "貼文 #3",
        content: "第三條刪除",
        wordCount: 5,
        createdAt: "2026-05-03T00:00:00.000Z",
      },
    ]);

    const deleted = await deleteArchiveEpisodes(archive.id, [
      episodes[1].archivePostId!,
      episodes[2].archivePostId!,
    ]);

    expect(deleted?.posts.map((post) => post.content)).toEqual(["第一條保留"]);
    expect(deleted?.publishHistory || []).toHaveLength(0);
    expect(getPersonaMemory(archive.id).entries).toHaveLength(0);
    expect(getCachedPersonaArchives()[0].posts.map((post) => post.content)).toEqual(["第一條保留"]);
  });

  it("preserves image urls when archive posts are saved and restored", async () => {
    const archive = await createPersonaArchive({
      id: "archive-image-preserve",
      name: "圖片儲存測試",
      content: "測試人設",
    });
    const imageUrl = "data:image/png;base64,aW1hZ2U=";
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "這條文案帶圖片。",
      wordCount: 8,
      createdAt: "2026-05-01T00:00:00.000Z",
      imageUrl,
    }]);

    const cached = getCachedPersonaArchives()[0];
    expect(cached.posts[0].imageUrl).toBe(imageUrl);
    expect(episode.imageUrl).toBe(imageUrl);
    expect(archivePostsToEpisodes(cached.posts)[0].imageUrl).toBe(imageUrl);
  });

  it("syncs images added after archive append back into the archive", async () => {
    const archive = await createPersonaArchive({
      id: "archive-image-late-sync",
      name: "後補圖片測試",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "先生成文案，後補圖片。",
      wordCount: 10,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);
    const imageUrl = "data:image/jpeg;base64,bGF0ZS1pbWFnZQ==";

    const saved = await updateArchiveEpisode(archive.id, {
      ...episode,
      imageUrl,
      updatedAt: "2026-05-01T01:00:00.000Z",
    });

    expect(saved?.imageUrl).toBe(imageUrl);
    expect(getCachedPersonaArchives()[0].posts[0].imageUrl).toBe(imageUrl);
  });

  it("keeps archive posts queued if memory persistence fails", async () => {
    const archive = await createPersonaArchive({
      id: "atomic-memory-fail",
      name: "記憶失敗保護",
      content: "測試人設",
    });
    const [episode] = await appendEpisodesToArchive(archive.id, [{
      number: 1,
      title: "貼文 #1",
      content: "這條內容不能在記憶失敗時從待發佇列消失。",
      wordCount: 21,
      createdAt: "2026-05-01T00:00:00.000Z",
    }]);
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(key, value) {
      if (key === "persona_memory_atomic-memory-fail") {
        throw new Error("memory write failed");
      }
      return originalSetItem.call(this, key, value);
    });

    await expect(markArchiveEpisodesPublished(archive.id, [episode.archivePostId!]))
      .rejects.toThrow("memory write failed");

    expect(getCachedPersonaArchives()[0].posts).toHaveLength(1);
    expect(getPersonaMemory(archive.id).entries).toHaveLength(0);
  });
});
