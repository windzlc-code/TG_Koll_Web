import { describe, expect, it } from "vitest";
import {
  buildListPaginationRows,
  buildManualConfirmCallback,
  buildSimplePagedCallback,
  buildPersonaContentTypeCallback,
  buildPersonaContentTypePickerRows,
  buildPadDetailActionRows,
  buildPublishPadSelectionRows,
  buildPostDetailText,
  buildPostImagePreviewOptions,
  buildPostImageRegenerateCallback,
  buildPersonaSettingsRows,
  buildPersonaPlatformAccountRows,
  buildLinkEndingSettingsRows,
  buildLinkEndingPresetEditRows,
  calculateSentimentHotRewriteMinLength,
  formatPersonaSettingsHotMetricsLines,
  buildPostDetailActionRows,
  buildStoredPostPublishConfirmRows,
  buildStoredPostMediaManageKeyboard,
  buildStoredPostsListView,
  aggregatePublishedTargets,
  derivePersonaSpecFromPrompt,
  filterPersonaMenuList,
  formatCloudAccountStateNotice,
  formatUserFacingError,
  inferStoredPostMediaKind,
  isSentimentHotRewriteTooShort,
  normalizeThreadsProfileLinkInput,
  parseLinkEndingPresetFromText,
  parseSimplePagedCallback,
  parsePersonaContentTypeCallback,
  parseStoredPostsCallback,
  applyLinkEndingPresetToText,
  removeLinkEndingPresetFromText,
} from "@/telegram-bot";
import type { PersonaArchive } from "@/core/archives/persona-archive-domain";

function archiveForSettings(overrides: Partial<PersonaArchive> = {}): PersonaArchive {
  return {
    id: "persona-settings-test",
    name: "設定測試人設",
    content: "測試人設",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    setup: {
      genres: ["生活"],
      personaPersonality: "溫柔",
      personaGender: "女性",
      personaStyle: "日常分享",
      totalEpisodes: 50,
      targetMarket: "cn",
      chineseScript: "traditional",
    },
    posts: [],
    ...overrides,
  };
}

function flattenButtonTexts(rows: Array<Array<{ text: string }>>) {
  return rows.flat().map((button) => button.text);
}

function flattenButtonCallbacks(rows: Array<Array<{ callback_data: string }>>) {
  return rows.flat().map((button) => button.callback_data);
}

describe("derivePersonaSpecFromPrompt", () => {
  it("generates persisted interest tags for new personas", () => {
    const spec = derivePersonaSpecFromPrompt("basketball creator");

    expect(spec.setup.interests?.length).toBeGreaterThan(0);
    expect(spec.setup.interests?.every((item) => item.length <= 12)).toBe(true);
  });

  it("uses a short custom prompt as the persona name and keeps basketball content aligned", () => {
    const spec = derivePersonaSpecFromPrompt("篮球大佬");

    expect(spec.name).toBe("篮球大佬");
    expect(spec.setup.genres).toEqual(["篮球大佬"]);
    expect(spec.setup.personaName).toBe("篮球大佬");
    expect(spec.content).toContain("篮球大佬人设");
    expect(spec.content).toContain("训练营");
    expect(spec.content).not.toContain("理财");
  });

  it("keeps beauty distribution personas in the beauty domain instead of finance fallback", () => {
    const spec = derivePersonaSpecFromPrompt("福利美女传播型，日常自拍，带互动钩子但不要露骨");

    expect(spec.name).toBe("福利美女传播型");
    expect(spec.setup.genres).toEqual(["美女传播型"]);
    expect(spec.setup.personaGender).toBe("女性");
    expect(spec.content).toContain("福利美女传播型人设");
    expect(spec.content).toContain("不低俗");
    expect(spec.content).not.toContain("理财");
  });
});

describe("stored post media previews", () => {
  it("treats data image posts as separately previewable images instead of unsupported content", () => {
    const text = buildPostDetailText(2, "今天喝咖啡", "data:image/png;base64,AAAA");

    expect(inferStoredPostMediaKind("data:image/png;base64,AAAA")).toBe("image");
    expect(text).toMatch(/可點擊下方按[钮鈕]查看/);
    expect(text).not.toContain("不支持");
    expect(buildPostImagePreviewOptions("data:image/png;base64,AAAA")).toEqual({});
  });

  it("treats data video posts as video previews instead of image preview failures", () => {
    const text = buildPostDetailText(3, "今天拍了一段影片", "data:video/mp4;base64,AAAA");

    expect(inferStoredPostMediaKind("data:video/mp4;base64,AAAA")).toBe("video");
    expect(text).toMatch(/可點擊下方按[钮鈕]查看/);
    expect(text).not.toContain("配图");
    expect(text).not.toContain("不支持");
  });

  it("keeps http image link previews even when the URL has no image extension", () => {
    const options = buildPostImagePreviewOptions("https://example.com/generated?id=123");

    expect(inferStoredPostMediaKind("https://example.com/generated?id=123")).toBe("image");
    expect(JSON.stringify(options)).toContain("prefer_large_media");
  });
});

describe("publish history metrics", () => {
  it("does not treat imported hot-source metrics as published account metrics", () => {
    const sourceUrl = "https://www.threads.net/@source/post/original";
    const record: NonNullable<PersonaArchive["publishHistory"]>[number] = {
      id: "history-source-pollution",
      archivePostId: "post-1",
      title: "published imported hot post",
      content: "reposted content",
      wordCount: 16,
      publishedAt: "2026-06-28T00:00:00.000Z",
      platform: "threads",
      sourceMeta: {
        source: "sentiment_hot_import",
        platform: "threads",
        sourceUrl,
        hotScore: 50000,
        engagement: { likeCount: 1000, commentCount: 100, viewCount: 50000 },
      },
      publishedMeta: {
        source: "published_post",
        platform: "threads",
        sourceUrl,
        hotScore: 50000,
        engagement: { likeCount: 1000, commentCount: 100, viewCount: 50000 },
      },
      publishedTargets: [
        {
          platform: "threads",
          padCode: "PAD-1",
          publishedUrl: sourceUrl,
          publishedMeta: {
            source: "published_post",
            platform: "threads",
            sourceUrl,
            hotScore: 50000,
            engagement: { likeCount: 1000, commentCount: 100, viewCount: 50000 },
          },
        },
      ],
    };

    expect(aggregatePublishedTargets(record)).toBeUndefined();
  });

  it("keeps valid published target metrics even when the source post exists", () => {
    const sourceUrl = "https://www.threads.net/@source/post/original";
    const ownUrl = "https://www.threads.net/@mine/post/repost";
    const record: NonNullable<PersonaArchive["publishHistory"]>[number] = {
      id: "history-valid-published",
      archivePostId: "post-1",
      title: "published imported hot post",
      content: "reposted content",
      wordCount: 16,
      publishedAt: "2026-06-28T00:00:00.000Z",
      platform: "threads",
      sourceMeta: {
        source: "sentiment_hot_import",
        platform: "threads",
        sourceUrl,
        hotScore: 50000,
        engagement: { likeCount: 1000, commentCount: 100, viewCount: 50000 },
      },
      publishedTargets: [
        {
          platform: "threads",
          padCode: "PAD-1",
          publishedUrl: ownUrl,
          publishedMeta: {
            source: "published_post",
            platform: "threads",
            sourceUrl: ownUrl,
            hotScore: 25,
            engagement: { likeCount: 2, commentCount: 1, viewCount: 25 },
            metrics: { like_count: 2, comment_count: 1, view_count: 25 },
          },
        },
      ],
    };

    expect(aggregatePublishedTargets(record)).toMatchObject({
      source: "published_post_aggregate",
      hotScore: 25,
      engagement: { likeCount: 2, commentCount: 1, viewCount: 25 },
    });
  });
});

describe("buildPersonaSettingsRows", () => {
  it("keeps the persona intro edit entry connected to the existing editcontent flow", () => {
    const archive = archiveForSettings();
    const rows = buildPersonaSettingsRows(archive);
    const buttons = rows.flat();

    expect(buttons).toContainEqual({ text: "🧾 人設簡介", callback_data: `editcontent_${archive.id}` });
  });

  it("shows link settings in the main two-column persona settings layout", () => {
    const archive = archiveForSettings();
    const rows = buildPersonaSettingsRows(archive);
    const buttons = rows.flat();

    expect(buttons).toContainEqual({ text: "🔗 链接设置", callback_data: `linksettings_${archive.id}` });
    expect(rows[1]).toEqual([
      { text: "🧾 人設簡介", callback_data: `editcontent_${archive.id}` },
      { text: "🔗 链接设置", callback_data: `linksettings_${archive.id}` },
    ]);
    expect(rows.every((row) => row.length <= 2)).toBe(true);
  });

  it("shows the persona hot-data panel entry by default", () => {
    const texts = flattenButtonTexts(buildPersonaSettingsRows(archiveForSettings()));

    expect(texts).toContain("🔥 人設熱點數據");
    expect(texts).not.toContain("📊 详细人设数据");
  });

  it("keeps hot-data mode controls inside the independent panel", () => {
    const texts = flattenButtonTexts(buildPersonaSettingsRows(archiveForSettings(), {
      hotMode: "detail",
      hotFields: ["followers", "views"],
    }));

    expect(texts).toContain("🔥 人設熱點數據");
    expect(texts).not.toContain("🔄 刷新數據");
    expect(texts).not.toContain("✅ 粉絲");
  });

  it("hides persona-image controls for workflow personas", () => {
    const rows = buildPersonaSettingsRows(archiveForSettings({
      setup: {
        ...archiveForSettings().setup!,
        imageWorkflow: {
          provider: "comfyui",
          workflowFile: "人设3小mii.json",
        },
      },
    }));

    expect(flattenButtonTexts(rows)).not.toContain("🎨 生成人设图");
    expect(flattenButtonTexts(rows)).not.toContain("👁 查看人设图");
    expect(flattenButtonTexts(rows)).not.toContain("🔄 重新生成人设图");
  });

  it("shows generate for non-workflow personas without a stored reference image", () => {
    const texts = flattenButtonTexts(buildPersonaSettingsRows(archiveForSettings()));

    expect(texts).toContain("🎨 生成人设图");
    expect(texts).not.toContain("👁 查看人设图");
    expect(texts).not.toContain("🔄 重新生成人设图");
  });

  it("shows view and regenerate for non-workflow personas with a stored reference image", () => {
    const texts = flattenButtonTexts(buildPersonaSettingsRows(archiveForSettings({
      personaReferenceSheet: "data:image/png;base64,cmVm",
    })));

    expect(texts).not.toContain("🎨 生成人设图");
    expect(texts).toContain("👁 查看人设图");
    expect(texts).toContain("🔄 重新生成人设图");
  });
});

describe("buildPersonaPlatformAccountRows", () => {
  it("replaces Threads hot refresh with the account-binding entry", () => {
    const texts = flattenButtonTexts(buildPersonaPlatformAccountRows("persona-settings-test", "threads", undefined, archiveForSettings()));

    expect(texts).toContain("🪪 人设账号绑定");
    expect(texts).not.toContain("🔥 热点刷新");
    expect(texts).not.toContain("🔥 绑定用户名并刷新热点");
  });
});

describe("buildPadDetailActionRows", () => {
  it("keeps duplicated Threads account actions out of cloud machine details", () => {
    const callbacks = buildPadDetailActionRows().flat().map((button) => button.callback_data);

    expect(callbacks).toEqual(["pad_mgmt"]);
    expect(callbacks.some((callback) => callback.startsWith("pad_query_account_"))).toBe(false);
    expect(callbacks.some((callback) => callback.startsWith("pad_switch_account_"))).toBe(false);
    expect(callbacks.some((callback) => callback.startsWith("pad_threads_profile_"))).toBe(false);
    expect(callbacks.some((callback) => callback.startsWith("pad_threads_auto_reply_"))).toBe(false);
    expect(callbacks.some((callback) => callback.startsWith("warmup_start_"))).toBe(false);
  });
});

describe("link ending presets", () => {
  it("renders editable preset rows with an empty checkbox for inactive presets", () => {
    const rows = buildLinkEndingSettingsRows("archive-1", {
      activeLinkEndingPresetId: "preset-b",
      linkEndingPresets: [
        {
          id: "preset-a",
          name: "模板A",
          endingText: "结尾A",
          linkUrl: "https://example.com/a",
          enabled: false,
        },
        {
          id: "preset-b",
          name: "模板B",
          endingText: "结尾B",
          linkUrl: "https://example.com/b",
          enabled: true,
        },
      ],
    });
    const texts = rows.flat().map((button) => button.text);
    const callbacks = rows.flat().map((button) => button.callback_data);

    expect(texts).toContain("☐ 模板A");
    expect(texts).toContain("✅ 模板B");
    expect(texts).not.toContain("⭕ 模板A");
    expect(callbacks).toContain("lpe_archive-1_0");
    expect(callbacks).toContain("lpd_archive-1_0");
  });

  it("renders content editing only inside a preset edit panel", () => {
    const rows = buildLinkEndingPresetEditRows("archive-1", 2);
    const callbacks = rows.flat().map((button) => button.callback_data);

    expect(callbacks).toContain("lpn_archive-1_2");
    expect(callbacks).toContain("lpc_archive-1_2");
    expect(callbacks).toContain("linksettings_archive-1");
  });

  it("parses ending text and URL even when the user sends them on one line", () => {
    const preset = parseLinkEndingPresetFromText("你好啊https://example.com/more");

    expect(preset).toEqual({
      name: "你好啊",
      linkUrl: "https://example.com/more",
      endingText: "你好啊",
    });
  });

  it("appends the active ending and link without duplicating old copies", () => {
    const content = "今天整理了一些重點。\n你好啊\nhttps://example.com/more";
    const next = applyLinkEndingPresetToText(content, {
      endingText: "你好啊",
      linkUrl: "https://example.com/more",
    });

    expect(next).toContain("今天整理了一些重點。");
    expect(next.endsWith("你好啊\nhttps://example.com/more")).toBe(true);
    expect(next.match(/你好啊/g)).toHaveLength(1);
    expect(next.match(/https:\/\/example\.com\/more/g)).toHaveLength(1);
  });

  it("removes the active ending and link before rewrite prompts", () => {
    const content = [
      "core body before rewrite",
      "fixed ending block",
      "https://example.com/more",
    ].join("\n");
    const next = removeLinkEndingPresetFromText(content, {
      endingText: "fixed ending block",
      linkUrl: "https://example.com/more",
    });

    expect(next).toBe("core body before rewrite");
  });

  it("only removes active ending text from the trailing template block", () => {
    const content = [
      "fixed ending block 这句在正文里也有价值，不能被删除。",
      "core body before rewrite",
      "fixed ending block",
      "https://example.com/more",
    ].join("\n");
    const next = removeLinkEndingPresetFromText(content, {
      endingText: "fixed ending block",
      linkUrl: "https://example.com/more",
    });

    expect(next).toBe([
      "fixed ending block 这句在正文里也有价值，不能被删除。",
      "core body before rewrite",
    ].join("\n"));
  });
});

describe("formatPersonaSettingsHotMetricsLines", () => {
  it("renders account metrics with recent views", () => {
    const archive = archiveForSettings({
      setup: {
        ...archiveForSettings().setup!,
        accountManagement: {
          threads: { handle: "stevie875443" },
        },
        hotMetrics: {
          "threads:stevie875443": {
            platform: "threads",
            username: "stevie875443",
            followers: 4,
            following: 12,
            recentViews: 61000,
            lightRefreshedAt: "2026-06-26T02:51:58.000Z",
          },
        },
      },
    });

    const lines = formatPersonaSettingsHotMetricsLines(archive, { mode: "light" });
    const text = lines.join("\n");

    expect(lines[0]).toContain("Threads：帳號 @stevie875443");
    expect(text).toContain("粉絲 4");
    expect(text).toContain("最近瀏覽 6.1萬");
  });

  it("renders detail metrics without duplicated summary wording", () => {
    const archive = archiveForSettings({
      setup: {
        ...archiveForSettings().setup!,
        accountManagement: {
          threads: { handle: "stevie875443" },
        },
        hotMetrics: {
          "threads:stevie875443": {
            platform: "threads",
            username: "stevie875443",
            followers: 4,
            following: 12,
            recentViews: 61000,
            posts: 20,
            likes: 1591,
            comments: 244,
            reposts: 95,
            shares: 98,
            views: 63298,
            complete: true,
            refreshedAt: "2026-06-26T02:51:58.000Z",
          },
        },
      },
    });

    const lines = formatPersonaSettingsHotMetricsLines(archive, {
      mode: "detail",
      fields: ["posts", "likes", "views"],
    });

    expect(lines.join("\n")).toContain("推文 20");
    expect(lines.join("\n")).toContain("點讚 1.6k");
    expect(lines.join("\n")).toContain("瀏覽 6.3萬");
    expect(lines.join("\n")).not.toContain("汇总");
  });
});

describe("sentiment hot rewrite quality gate", () => {
  it("rejects very short persona-style rewrites for long imported hot posts", () => {
    const original = [
      "分享用海外收入申請台灣的信貸心得，由於是第一次申請信貸，事前做了不少功課。",
      "後來選擇一家銀行，期間需要準備薪轉、公司收入證明、扣繳憑單和財力資料。",
      "審核時銀行會電話確認細節，也會看負債比、收入穩定性和用途。",
      "整體流程大約一週，利率比想像中低，但每個人條件不同，不能直接照抄。",
      "如果是海外薪資，最好先準備好完整文件，並且找願意承作的銀行窗口。",
    ].join("");

    expect(calculateSentimentHotRewriteMinLength(original, "persona_style")).toBeGreaterThanOrEqual(90);
    expect(isSentimentHotRewriteTooShort(original, "午後的陽光剛好灑進教研室，看著桌上剛整理好的財務教案，老師想和大家分享一個很實用的觀念", "persona_style")).toBe(true);
    expect(isSentimentHotRewriteTooShort(original, `${original} 這段如果換成現在的人設角度，還需要補上自己的判斷和提醒。`, "persona_style")).toBe(false);
  });

  it("does not require more characters than a short source post contains", () => {
    const original = "今天下雨，出門記得帶傘。";

    expect(calculateSentimentHotRewriteMinLength(original, "persona_style")).toBe(Array.from(original.replace(/\s+/g, "")).length);
    expect(isSentimentHotRewriteTooShort(original, original, "persona_style")).toBe(false);
  });
});

describe("filterPersonaMenuList", () => {
  it("keeps newly created personas visible even when workflow personas exist", () => {
    const list = filterPersonaMenuList([
      { id: "c452e276-cc6c-40c0-855b-00e1a32a68bf", name: "高校讲台老师", postCount: 0 },
      { id: "workflow-persona-jinjunya", name: "金君雅", imageWorkflow: true, postCount: 38 },
    ]);

    expect(list.map((item) => item.id)).toEqual([
      "c452e276-cc6c-40c0-855b-00e1a32a68bf",
      "workflow-persona-jinjunya",
    ]);
  });
});

describe("generic list pagination", () => {
  it("builds first/prev/next/last controls for middle pages", () => {
    const rows = buildListPaginationRows({
      page: 1,
      totalPages: 3,
      callbackForPage: (page) => buildSimplePagedCallback("list_personas", page),
    });
    const buttons = rows.flat();

    expect(buttons.map((button) => button.text)).toEqual([
      "⏮ 首頁",
      "◀️ 上一頁",
      "2/3",
      "下一頁 ▶️",
      "尾頁 ⏭",
    ]);
    expect(buttons.find((button) => button.text === "⏮ 首頁")?.callback_data).toBe("list_personas");
    expect(buttons.find((button) => button.text === "尾頁 ⏭")?.callback_data).toBe("list_personas_p2");
  });

  it("parses simple paged callbacks", () => {
    expect(parseSimplePagedCallback("list_personas", "list_personas")).toBe(0);
    expect(parseSimplePagedCallback("list_personas_p3", "list_personas")).toBe(3);
    expect(parseSimplePagedCallback("list_personas_px", "list_personas")).toBeNull();
  });
});

describe("buildManualConfirmCallback", () => {
  it("keeps workflow persona publish retry callbacks self-contained", () => {
    expect(buildManualConfirmCallback("workflow-persona-jinjunya", "threads", 2, 1))
      .toBe("manualpub_confirm_workflow-persona-jinjunya_threads_2_1");
  });

  it("uses a compact self-contained callback for UUID archive ids", () => {
    expect(buildManualConfirmCallback("e5fbd3a9-6415-4709-a1cd-e22f79bd4c08", "threads", 0, 3))
      .toBe("mcf_ue5fbd3a964154709a1cde22f79bd4c08_h_0_3");
  });

  it("falls back to the state-backed callback only when the archive id cannot fit safely", () => {
    expect(buildManualConfirmCallback("自定义人设".repeat(20), "threads", 0, 1)).toBe("mconfirm");
  });
});

describe("stored posts pagination", () => {
  const posts = Array.from({ length: 8 }, (_, index) => ({
    id: `post-${index + 1}`,
    content: `第${index + 1}篇内容`,
  }));

  it("shows pagination when stored posts exceed one page", () => {
    const view = buildStoredPostsListView("archive-1", posts, 0);

    expect(view.totalPages).toBe(2);
    expect(view.visiblePostIds).toEqual(["post-1", "post-2", "post-3", "post-4", "post-5"]);
    expect(view.postIds).toEqual(posts.map((post) => post.id));
    expect(view.text).toContain("第 1/2 頁");
    expect(view.keyboard.flat().map((button) => button.text)).toContain("下一頁 ▶️");
    expect(view.keyboard.flat().map((button) => button.text)).toContain("🚀 發布推文");
    expect(view.keyboard.flat().map((button) => button.text)).toContain("🗑 刪除推文");
    expect(view.keyboard.flat().map((button) => button.text)).not.toContain("👁 查看第6篇");
  });

  it("formats fixed tweet links as Telegram text links in stored post lists", () => {
    const url = "https://t.me/gy_night_flight_bot";
    const text = "\u5feb\u9ede\u6211\u770b\u66f4\u591a\u5427\u2764\ufe0f";
    const longBody = "\u54e5\u54e5\u5011\uff5e\u65e9\u5b89\u5b89\u2764\ufe0f".repeat(20);
    const view = buildStoredPostsListView(
      "archive-1",
      [{ id: "post-1", content: `${longBody}\n${url}` }],
      0,
      5,
      { url, text },
    );

    expect(view.text).toContain(`<a href="${url}">${text}</a>`);
    expect(view.text).not.toContain(`>${url}</a>`);
  });

  it("maps action buttons to the current stored posts page", () => {
    const view = buildStoredPostsListView("archive-1", posts, 1);

    expect(view.visiblePostIds).toEqual(["post-6", "post-7", "post-8"]);
    expect(view.postIds).toEqual(posts.map((post) => post.id));
    expect(view.text).toContain("<b>【6】</b> <b>类型: 純文字</b>\n第6篇内容");
    expect(view.keyboard.flat().map((button) => button.text)).toContain("👁 查看第6篇（純文字）");
    expect(view.keyboard.flat().map((button) => button.text)).toContain("◀️ 上一頁");
  });

  it("uses global view indexes on later pages and keeps publish/delete as bottom bulk actions", () => {
    const view = buildStoredPostsListView("archive-1", posts, 1);
    const buttons = view.keyboard.flat();

    expect(buttons.find((button) => button.text === "👁 查看第8篇（純文字）")?.callback_data).toBe("vp_7");
    expect(buttons.find((button) => button.text === "🚀 发布第8篇")).toBeUndefined();
    expect(buttons.find((button) => button.text === "🗑 删除第8篇")).toBeUndefined();
    expect(buttons.find((button) => button.text === "🚀 發布推文")?.callback_data).toBe("bulkpub_archive-1_p1");
    expect(buttons.find((button) => button.text === "🗑 刪除推文")?.callback_data).toBe("bulkdel_archive-1_p1");
  });

  it("labels mixed image and video posts in the list", () => {
    const view = buildStoredPostsListView("archive-1", [{
      id: "post-mixed",
      content: "混合媒體推文",
      mediaItems: [
        { url: "https://example.com/one.jpg", type: "image" },
        { url: "https://example.com/two.mp4", type: "video" },
      ],
    }]);

    expect(view.text).toContain("<b>【1】</b> <b>类型: 圖片+視頻</b>");
    expect(view.keyboard.flat().map((button) => button.text)).toContain("👁 查看第1篇（圖片+視頻）");
  });

  it("adds visual media type icons to media management buttons", () => {
    const rows = buildStoredPostMediaManageKeyboard({
      mediaItems: [
        { url: "https://example.com/one.jpg", type: "image" },
        { url: "https://example.com/two.mp4", type: "video" },
      ],
      selectedIndexes: [1],
    });
    const texts = rows.flat().map((button) => button.text);

    expect(texts).toContain("⬜️ 🖼 1.圖片");
    expect(texts).toContain("☑️ 🎬 2.視頻");
    expect(texts).toContain("🎬 播放視頻 2");
    expect(texts).toContain("✅ 全選");
    expect(texts).toContain("🧹 清空");
  });

  it("keeps stored post actions inside the selected Telegram content branch", () => {
    const paidPosts = posts.map((post) => ({ ...post, telegramGroupContentType: "paid" as const }));
    const view = buildStoredPostsListView("archive-1", paidPosts, 1, 5, null, "paid");
    const buttons = view.keyboard.flat();

    expect(view.text).toContain("付費內容");
    expect(buttons.find((button) => button.text === "◀️ 上一頁")?.callback_data).toBe("posts_archive-1_ct_paid_p0");
    expect(buttons.find((button) => button.text === "🚀 發布推文")?.callback_data).toBe("bulkpub_archive-1_ct_paid_p1");
    expect(buttons.find((button) => button.text === "🗑 刪除推文")?.callback_data).toBe("bulkdel_archive-1_ct_paid_p1");
    expect(buttons.find((button) => button.text === "◀️ 返回")?.callback_data).toBe("posts_branch_archive-1");
  });

  it("parses stored post page callbacks", () => {
    expect(parseStoredPostsCallback("posts_archive-1_p2")).toEqual({ archiveId: "archive-1", page: 2 });
    expect(parseStoredPostsCallback("posts_archive-1_ct_paid_p2")).toEqual({ archiveId: "archive-1", groupContentType: "paid", page: 2 });
    expect(parseStoredPostsCallback("posts_archive-1_ct_free")).toEqual({ archiveId: "archive-1", groupContentType: "free", page: 0 });
    expect(parseStoredPostsCallback("posts_archive-1")).toEqual({ archiveId: "archive-1", page: 0 });
  });
});

describe("persona content branch picker", () => {
  it("shows content counts on every branch button and keeps callbacks compact", () => {
    for (const target of ["posts", "history", "publish"] as const) {
      const rows = buildPersonaContentTypePickerRows({
        archiveId: "workflow-persona-jinjunya",
        target,
        counts: { free: 3, paid: 2 },
      });
      const buttons = rows.flat();

      expect(buttons[0].text).toContain("3");
      expect(buttons[1].text).toContain("2");
      expect(buttons[0].callback_data.length).toBeLessThanOrEqual(64);
      expect(buttons[1].callback_data.length).toBeLessThanOrEqual(64);
      expect(parsePersonaContentTypeCallback(buttons[0].callback_data)).toEqual({
        target,
        archiveId: "workflow-persona-jinjunya",
        groupContentType: "free",
      });
      expect(parsePersonaContentTypeCallback(buttons[1].callback_data)).toEqual({
        target,
        archiveId: "workflow-persona-jinjunya",
        groupContentType: "paid",
      });
    }
  });

  it("parses legacy branch callbacks for existing Telegram messages", () => {
    expect(parsePersonaContentTypeCallback("posts_archive-1_ct_free")).toEqual({
      target: "posts",
      archiveId: "archive-1",
      groupContentType: "free",
    });
    expect(parsePersonaContentTypeCallback("history_archive-1_ct_paid")).toEqual({
      target: "history",
      archiveId: "archive-1",
      groupContentType: "paid",
    });
    expect(parsePersonaContentTypeCallback("pub_archive-1_ct_paid")).toEqual({
      target: "publish",
      archiveId: "archive-1",
      groupContentType: "paid",
    });
  });

  it("builds callbacks for direct preview buttons for every target", () => {
    expect(parsePersonaContentTypeCallback(buildPersonaContentTypeCallback("posts", "workflow-persona-jinjunya", "free"))).toEqual({
      target: "posts",
      archiveId: "workflow-persona-jinjunya",
      groupContentType: "free",
    });
    expect(parsePersonaContentTypeCallback(buildPersonaContentTypeCallback("history", "workflow-persona-jinjunya", "paid"))).toEqual({
      target: "history",
      archiveId: "workflow-persona-jinjunya",
      groupContentType: "paid",
    });
    expect(parsePersonaContentTypeCallback(buildPersonaContentTypeCallback("publish", "workflow-persona-jinjunya", "free"))).toEqual({
      target: "publish",
      archiveId: "workflow-persona-jinjunya",
      groupContentType: "free",
    });
  });
});

describe("buildPostDetailActionRows", () => {
  it("shows text regeneration and standalone image generation for text-only posts", () => {
    const rows = buildPostDetailActionRows({
      hasImage: false,
      publishCallback: "post_action",
      deleteCallback: "post_delete_action",
      archiveId: "archive-1",
    });
    const texts = flattenButtonTexts(rows);

    expect(texts).toContain("🔄 重新生成推文");
    expect(texts).toContain("🖼 单独生成图片");
    expect(texts).not.toContain("🖼 查看配图/视频");
    expect(texts).not.toContain("🖼 重新生成图片");
  });

  it("shows image regeneration for ordinary posts that already have images", () => {
    const rows = buildPostDetailActionRows({
      hasImage: true,
      publishCallback: "post_action",
      deleteCallback: "post_delete_action",
      archiveId: "archive-1",
    });
    const texts = flattenButtonTexts(rows);

    expect(texts).toContain("🔄 重新生成推文");
    expect(texts).toContain("🖼 查看配圖/視頻");
    expect(texts).not.toContain("🧩 管理媒体");
    expect(texts).not.toContain("编辑文案/媒体");
    expect(texts).toContain("🖼 重新生成图片");
    expect(texts).not.toContain("🖼 单独生成图片");
  });
  it("shows the source metrics refresh action only when enabled", () => {
    const baseRows = buildPostDetailActionRows({
      hasImage: true,
      publishCallback: "post_action",
      deleteCallback: "post_delete_action",
      archiveId: "archive-1",
    });
    const refreshRows = buildPostDetailActionRows({
      hasImage: true,
      publishCallback: "post_action",
      deleteCallback: "post_delete_action",
      archiveId: "archive-1",
      canRefreshMetrics: true,
    });

    expect(flattenButtonCallbacks(baseRows)).not.toContain("post_refresh_metrics");
    expect(flattenButtonCallbacks(refreshRows)).toContain("post_refresh_metrics");
  });

  it("shows media management and custom editing only for sentiment-imported posts", () => {
    const rows = buildPostDetailActionRows({
      hasImage: true,
      publishCallback: "post_action",
      deleteCallback: "post_delete_action",
      archiveId: "archive-1",
      allowSentimentEditControls: true,
    });
    const texts = flattenButtonTexts(rows);
    const callbacks = flattenButtonCallbacks(rows);

    expect(texts).toContain("🧩 媒體管理");
    expect(texts).toContain("✏️ 文案管理");
    expect(texts).not.toContain("编辑文案/媒体");
    expect(callbacks).toContain("post_media_manage");
    expect(callbacks).toContain("post_edit_custom");
    expect(callbacks).not.toContain("post_media_preview");
    expect(callbacks).not.toContain("post_img_regen");
    expect(callbacks).not.toContain("post_regen");
  });

  it("adds favorite and custom back callbacks when requested", () => {
    const rows = buildPostDetailActionRows({
      hasImage: true,
      publishCallback: "post_action",
      deleteCallback: "post_delete_action",
      archiveId: "archive-1",
      favoriteCallback: "post_favorite_action",
      backCallback: "favs_archive-1_p0",
      backText: "back to favorites",
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("post_favorite_action");
    expect(callbacks).toContain("favs_archive-1_p0");
  });
});

describe("buildStoredPostPublishConfirmRows", () => {
  it("uses a safe default publish platform outside the bot runtime scope", () => {
    const rows = buildStoredPostPublishConfirmRows({
      archiveId: "archive-1",
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("post_action_threads");
    expect(callbacks).not.toContain("dop_threads");
  });

  it("does not show link template selection before choosing a publish platform", () => {
    const rows = buildStoredPostPublishConfirmRows({
      archiveId: "archive-1",
      hasSelectableLinkTemplates: true,
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("post_action_threads");
    expect(callbacks).not.toContain("post_link_templates");
  });

  it("shows link template selection after a publish platform is selected", () => {
    const rows = buildStoredPostPublishConfirmRows({
      archiveId: "archive-1",
      hasSelectableLinkTemplates: true,
      selectedPlatform: "threads" as any,
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("post_link_templates");
    expect(callbacks).toContain("dop_threads");
  });

  it("asks for a publish platform before showing direct publish options", () => {
    const rows = buildStoredPostPublishConfirmRows({
      archiveId: "archive-1",
      platforms: ["threads", "telegram"] as any,
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("post_action_threads");
    expect(callbacks).toContain("post_action_telegram");
    expect(callbacks).not.toContain("dop_threads");
    expect(callbacks).not.toContain("dopm_threads");
    expect(callbacks).not.toContain("sch_threads");
    expect(callbacks).not.toContain("schm_threads");
  });

  it("shows only the selected platform publish options after platform selection", () => {
    const rows = buildStoredPostPublishConfirmRows({
      archiveId: "archive-1",
      platforms: ["threads", "telegram"] as any,
      selectedPlatform: "threads" as any,
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("dop_threads");
    expect(callbacks).toContain("dopm_threads");
    expect(callbacks).toContain("post_action_clear");
    expect(callbacks).not.toContain("dop_telegram");
    expect(callbacks).not.toContain("dopm_telegram");
    expect(callbacks).not.toContain("sch_threads");
    expect(callbacks).not.toContain("schm_threads");
  });

  it("keeps sentiment hot imported posts on the same publish preview path", () => {
    const rows = buildStoredPostPublishConfirmRows({
      archiveId: "archive-1",
      isSentimentImported: true,
      platforms: ["threads", "telegram"] as any,
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("post_action_threads");
    expect(callbacks).toContain("post_action_telegram");
    expect(callbacks).not.toContain("dop_threads");
    expect(callbacks).not.toContain("dop_telegram");
    expect(callbacks).not.toContain("dopm_threads");
    expect(callbacks).not.toContain("sch_threads");
    expect(callbacks).not.toContain("schm_threads");
  });
});

describe("buildPublishPadSelectionRows", () => {
  it("builds selectable rows for multi-pad publishing", () => {
    const rows = buildPublishPadSelectionRows({
      pads: [
        { padCode: "PAD1", padName: "Cloud 1" },
        { padCode: "PAD2", padName: "Cloud 2" },
      ],
      selectedPadCodes: ["PAD2"],
    });
    const buttons = rows.flat();

    expect(buttons[0]?.callback_data).toBe("pubpad_toggle_0");
    expect(buttons[1]?.callback_data).toBe("pubpad_toggle_1");
    expect(buttons.find((button) => button.callback_data === "pubpad_confirm")?.text).toContain("1");
  });

  it("keeps page selection controls for large multi-pad publishing lists", () => {
    const pads = Array.from({ length: 13 }, (_, index) => ({
      padCode: `PAD${index + 1}`,
      padName: `Cloud ${index + 1}`,
    }));
    const rows = buildPublishPadSelectionRows({
      pads,
      selectedPadCodes: ["PAD12"],
      page: 1,
      pageSize: 10,
    });
    const callbacks = flattenButtonCallbacks(rows);

    expect(callbacks).toContain("pubpad_toggle_0");
    expect(callbacks).toContain("pubpad_select_page");
    expect(callbacks).toContain("pubpad_clear_page");
    expect(callbacks).toContain("pubpad_select_all");
    expect(callbacks).toContain("pubpad_clear_all");
    expect(callbacks).toContain("pubpad_page_0");
    expect(callbacks).toContain("pubpad_confirm");
  });
});
describe("buildPostImageRegenerateCallback", () => {
  it("keeps generated image regeneration callbacks short enough for Telegram", () => {
    const callback = buildPostImageRegenerateCallback("irmb9rx3tuabc123");

    expect(callback).toBe("pimgregen_irmb9rx3tuabc123");
    expect(callback.length).toBeLessThanOrEqual(64);
  });
});

describe("formatCloudAccountStateNotice", () => {
  it("formats phone verification as an account status notice instead of a generic failure", () => {
    const notice = formatCloudAccountStateNotice(
      "Threads 目前需要完成手机号验证码登录：LOCAL_PHONE_VERIFICATION_PAGE｜debug=D:\\tmp\\phone.jpg",
      { action: "养号", padName: "OP-TEST1", padCode: "ACP1" },
    );

    expect(notice?.kind).toBe("phone_verification");
    expect(notice?.status).toContain("手機號驗證碼");
    expect(notice?.text).toContain("這不是任務執行失敗");
    expect(notice?.debugPath).toBe("D:\\tmp\\phone.jpg");
  });

  it("formats captcha and human verification pages as an actionable status", () => {
    const notice = formatCloudAccountStateNotice(
      "__THREADS_BLOCKED__驗證你是真人，輸入圖片中的驗證碼",
      { action: "发布", padName: "F1 2.0" },
    );

    expect(notice?.kind).toBe("captcha");
    expect(notice?.shortStatus).toContain("驗證碼");
    expect(notice?.text).toContain("F1 2.0");
  });

  it("does not label onboarding/profile setup blockers as captcha", () => {
    const notice = formatCloudAccountStateNotice(
      "__THREADS_BLOCKED__Threads 個人頁目前停在阻斷頁：账号初始化/资料引导页",
      { action: "发布", padName: "F1 2.0" },
    );

    expect(notice?.kind).toBe("onboarding");
    expect(notice?.shortStatus).toContain("資料引導");
    expect(notice?.text).not.toContain("驗證碼/真人驗證頁");
  });

  it("keeps generic Threads blockers generic instead of calling them captcha", () => {
    const notice = formatCloudAccountStateNotice(
      "__THREADS_BLOCKED__檢測到 Threads 阻斷頁，需要人工確認當前帳號狀態",
      { action: "发布", padName: "F1 2.0" },
    );

    expect(notice?.kind).toBe("blocked");
    expect(notice?.status).not.toContain("验证码");
    expect(notice?.status).not.toContain("真人验证");
  });

  it("formats local Threads login activity blockers as login required", () => {
    const notice = formatCloudAccountStateNotice(
      "__THREADS_BLOCKED__Threads profile update blocked: LOCAL_THREADS_LOGIN_ACTIVITY",
      { action: "bio update", padName: "OP-TEST2" },
    );

    expect(notice?.kind).toBe("login_required");
    expect(notice?.text).toContain("OP-TEST2");
  });

  it("ignores ordinary automation failures", () => {
    expect(formatCloudAccountStateNotice("Threads 發布前未找到新串文輸入控件", { action: "发布" })).toBeNull();
  });
});

describe("formatUserFacingError", () => {
  it("hides screenshot data URLs and explains composer publish failures", () => {
    const message = formatUserFacingError(
      "發布後仍停留在輸入頁：LOCAL_COMPOSER｜screenshot=data:image/jpg;base64,/9j/4QAAAAAAAAAAAAAA",
      "发布失败，请稍后重试。",
    );

    expect(message).toContain("发布按钮没有生效");
    expect(message).toContain("新串文编辑页");
    expect(message).not.toContain("data:image");
    expect(message).not.toContain("base64");
    expect(message).not.toContain("LOCAL_COMPOSER");
  });

  it("hides local sample paths but keeps a readable diagnostic hint", () => {
    const message = formatUserFacingError(
      "Threads 發布前未找到新串文輸入/發布控件：unknown (LOCAL_THREADS_POST_ACTION_SHEET)｜sample=D:\\GitHub\\Automatic-script\\.runtime\\automatic-script\\publish-samples\\threads\\threads-image-composer-controls-missing\\sample.json",
      "发布失败，请稍后重试。",
    );

    expect(message).toContain("没有识别到新串文输入框或发布按钮");
    expect(message).toContain("诊断样本已保存");
    expect(message).toContain("sample.json");
    expect(message).not.toContain("LOCAL_THREADS_POST_ACTION_SHEET");
    expect(message).not.toContain("D:\\GitHub");
  });

  it("hides container sample paths for unconfirmed Threads caption input failures", () => {
    const message = formatUserFacingError(
      "Threads 文案输入未确认，已停止发布以避免点击灰色发布按钮｜sample=/app/tool_r18/.runtime/automatic-script/publish-samples/threads/threads-video-publish-top-level-failure/threads-video-publish-top-level-failure-1782155131339.json",
      "发布失败，请稍后重试。",
    );

    expect(message).toContain("Threads 文案没有确认输入成功");
    expect(message).toContain("诊断样本已保存");
    expect(message).toContain("threads-video-publish-top-level-failure-1782155131339.json");
    expect(message).not.toContain("/app/tool_r18");
    expect(message).not.toContain("sample=/app");
  });

  it("removes internal blocked markers and debug paths", () => {
    const message = formatUserFacingError(
      "__THREADS_BLOCKED__ 驗證你是真人｜debug=D:\\tmp\\blocked.jpg",
      "操作失败，请稍后重试。",
    );

    expect(message).toContain("驗證你是真人");
    expect(message).toContain("诊断样本已保存");
    expect(message).toContain("blocked.jpg");
    expect(message).not.toContain("__THREADS_BLOCKED__");
    expect(message).not.toContain("D:\\tmp");
  });

  it("formats missing cloud instances as a persona cloud binding issue", () => {
    const message = formatUserFacingError(
      "Cloud API error [2020]: Instance not found",
      "发布失败，请稍后重试。",
    );

    expect(message).toBe("当前人设绑定的设备不存在，请进入人设设置重新绑定可用设备。");
    expect(message).not.toContain("Cloud API");
    expect(message).not.toContain("Instance not found");
  });

  it("formats Codex 401 as an expired backend auth problem", () => {
    const message = formatUserFacingError(
      "OpenAI Codex v0.57.0 provider: openai ERROR: exceeded retry limit, last status: 401 Unauthorized",
      "指令执行失败，请稍后重试。",
    );

    expect(message).toContain("后台 Codex 认证已失效");
    expect(message).not.toContain("API Key 配置异常");
  });

  it("formats missing Telegram app errors as a direct cloud app issue", () => {
    const message = formatUserFacingError(
      "Activity class {org.telegram.messenger/org.telegram.ui.LaunchActivity} does not exist",
      "发布失败，请稍后重试。",
    );

    expect(message).toBe("该人设绑定的设备上未检测到 Telegram 应用，请先在这台设备安装并登录 Telegram。");
    expect(message).not.toContain("Activity class");
    expect(message).not.toContain("org.telegram");
  });

  it("formats Telegram share picker failures as a group selection issue", () => {
    const message = formatUserFacingError(
      "Telegram 群组媒体分享未离开选择聊天页，无法确认已发送。",
      "发布失败，请稍后重试。",
    );

    expect(message).toBe("Telegram 分享页没有选中目标群组，请先在设备 Telegram 里打开目标群组后重试。");
  });

  it("formats missing media staging as an upload issue", () => {
    const message = formatUserFacingError(
      "Telegram 群组媒体发布缺少 contentUri",
      "发布失败，请稍后重试。",
    );

    expect(message).toBe("图片或视频没有成功写入设备，请重新上传媒体后再发布。");
  });
});

describe("normalizeThreadsProfileLinkInput", () => {
  it("accepts full https links", () => {
    expect(normalizeThreadsProfileLinkInput("https://example.com/path?a=1")).toBe("https://example.com/path?a=1");
  });

  it("adds https for plain domains", () => {
    expect(normalizeThreadsProfileLinkInput("example.com/profile")).toBe("https://example.com/profile");
  });

  it("rejects non-web or incomplete values", () => {
    expect(normalizeThreadsProfileLinkInput("javascript:alert(1)")).toBeNull();
    expect(normalizeThreadsProfileLinkInput("not-a-domain")).toBeNull();
    expect(normalizeThreadsProfileLinkInput("https://exa mple.com")).toBeNull();
  });
});
