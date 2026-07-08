import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedPersonaArchives } from "@/lib/persona-archives";
import { loadPersonaArchive, savePersonaArchive } from "@/lib/persona-archives";
import { planPersonaPostGenerationBatches, runPersonaWorkflow } from "@/core/persona/persona-workflow-service";
import { getPersonaMemory, replacePersonaMemoryEntries } from "@/lib/persona-memory";
import { consolidateOldPersonaMemory } from "@/lib/persona-memory-v2";

const prompts: string[] = [];

vi.mock("@/lib/gemini-client", () => ({
  callGemini: vi.fn(async (_model: string, contents: any[]) => {
    const prompt = contents?.[0]?.parts?.[0]?.text || "";
    prompts.push(prompt);
    if (prompt.includes("壓縮成人設長期記憶")) {
      const sequence = prompt.match(/本篇序號：第\s*(\d+)\s*篇/)?.[1] || "1";
      return { text: `第${sequence}篇：主角上週去日本旅行，在東京便利店遇到一位老同學，留下下次再見的伏筆` };
    }
    if (prompt.includes("60 天以前的人設推文記憶")) {
      return { text: "2026年1月長期記憶：人設完成第1至第3章，主線是日本旅行後與東京老同學重逢，伏筆是回台北喝咖啡" };
    }
    return { text: "第1章：我上週去日本，在東京便利店撞見多年沒聯絡的老同學，手上的飯糰差點掉到地上。她說下次回台北要找我喝咖啡，這句話讓我一路想到現在" };
  }),
  callTextUnderstandingModelWithFallback: vi.fn(async (_model: string, contents: any[]) => {
    const prompt = contents?.[0]?.parts?.[0]?.text || "";
    prompts.push(prompt);
    if (prompt.includes("壓縮成人設長期記憶")) {
      const sequence = prompt.match(/本篇序號：第\s*(\d+)\s*篇/)?.[1] || "1";
      return { model: "gemini-3.1-pro-preview", data: { text: `第${sequence}篇：主角上週去日本旅行，在東京便利店遇到一位老同學，留下下次再見的伏筆` } };
    }
    if (prompt.includes("60 天以前的人設推文記憶")) {
      return { model: "gemini-3.1-pro-preview", data: { text: "2026年1月長期記憶：人設完成第1至第3章，主線是日本旅行後與東京老同學重逢，伏筆是回台北喝咖啡" } };
    }
    return { model: "gemini-3.1-pro-preview", data: { text: "第1章：我上週去日本，在東京便利店撞見多年沒聯絡的老同學，手上的飯糰差點掉到地上。她說下次回台北要找我喝咖啡，這句話讓我一路想到現在" } };
  }),
  extractText: (data: any) => data?.text || "",
  explainGeminiNoText: () => null,
  getProtocolEndpoint: () => ({ apiKey: "test-key", baseUrl: "https://example.test" }),
  isTextModelFallbackError: () => true,
}));

vi.mock("@/lib/persona-trend-intel-node", () => ({
  fetchPersonaTrendIntelForNode: vi.fn(async () => "【測試舆情】東京便利店新品討論"),
}));

describe("persona generation memory", () => {
  beforeEach(() => {
    prompts.length = 0;
    process.env.PERSONA_MEMORY_AI_TEST = "1";
    window.localStorage.clear();
  });

  it("generates an AI memory summary with each post and feeds it into the next generation", async () => {
    const created = await runPersonaWorkflow({
      action: "create",
      name: "連載故事人設",
      content: "一個用章節形式寫生活故事的人設。",
      setup: {
        genres: ["故事人設"],
        personaPersonality: "細膩",
        personaGender: "女性",
        personaStyle: "章節連載",
        totalEpisodes: 50,
        targetMarket: "cn",
        chineseScript: "traditional",
      },
    } as any);

    const archiveId = created.archiveId;
    const first = await runPersonaWorkflow({ action: "generate-posts", archiveId, count: 1 });
    expect(first.posts?.[0].title).toBe("第1篇");
    expect(first.posts?.[0].memorySummary).toContain("第1篇");
    expect(first.posts?.[0].memorySummary).toContain("日本");

    const [cached] = getCachedPersonaArchives().filter((archive) => archive.id === archiveId);
    expect(cached.posts[0].memorySummary).toContain("東京便利店");

    const second = await runPersonaWorkflow({ action: "generate-posts", archiveId, count: 1 });
    expect(second.posts?.[0].title).toBe("第2篇");
    const secondGenerationPrompt = prompts
      .filter((prompt) => prompt.includes("## 人設記憶"))
      .at(-1) || "";

    expect(second.posts?.[0].memorySummary).toContain("第2篇");
    expect(secondGenerationPrompt).toContain("第1篇：主角上週去日本旅行");
    expect(secondGenerationPrompt).toContain("如果是故事/章節型人設");
  });

  it("consolidates memory older than 60 days through the AI compression path", async () => {
    await replacePersonaMemoryEntries("old-memory-persona", [
      {
        id: "old-1",
        date: "2026-01-03T00:00:00.000Z",
        summary: "第1章：她上週去日本旅行，在東京便利店遇到老同學",
      },
      {
        id: "old-2",
        date: "2026-01-20T00:00:00.000Z",
        summary: "第2章：老同學約她回台北喝咖啡，她開始猶豫要不要赴約",
      },
      {
        id: "new-1",
        date: "2026-05-18T00:00:00.000Z",
        summary: "第8章：最近更新的內容不能被合併",
      },
    ]);

    await consolidateOldPersonaMemory(
      "old-memory-persona",
      "連載故事人設",
      "章節連載人設",
      new Date("2026-05-20T00:00:00.000Z"),
    );

    const entries = getPersonaMemory("old-memory-persona").entries;
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.kind === "consolidated" && entry.sourceCount === 2)).toBe(true);
    expect(entries.some((entry) => entry.summary.includes("第8章"))).toBe(true);
    expect(entries.some((entry) => entry.summary.includes("長期記憶"))).toBe(true);
  });

  it("injects selected persona memories as explicit anchors for generation", async () => {
    const created = await runPersonaWorkflow({
      action: "create",
      name: "記憶選擇人設",
      content: "一個會把生活經歷寫成短推文的人設。",
      setup: {
        genres: ["生活記錄"],
        personaPersonality: "溫柔",
        personaGender: "女性",
        personaStyle: "日常分享",
        totalEpisodes: 50,
        targetMarket: "cn",
        chineseScript: "traditional",
      },
    } as any);

    await replacePersonaMemoryEntries(created.archiveId, [
      {
        id: "memory-japan-week",
        date: "2026-05-26T00:00:00.000Z",
        summary: "一週前去了日本，在東京街角咖啡店看雨，買了一本設計雜誌。",
      },
      {
        id: "memory-other",
        date: "2026-05-20T00:00:00.000Z",
        summary: "在台北整理衣櫃，準備換季穿搭。",
      },
    ]);

    await runPersonaWorkflow({
      action: "generate-posts",
      archiveId: created.archiveId,
      count: 1,
      selectedMemoryEntryIds: ["memory-japan-week"],
    });

    const generationPrompt = prompts
      .filter((prompt) => prompt.includes("【本次用户勾选的人设记忆】"))
      .at(-1) || "";
    const selectedMemoryBlock = generationPrompt.split("**真人感要求")[0]?.split("【本次用户勾选的人设记忆】").at(-1) || "";

    expect(generationPrompt).toContain("一週前去了日本");
    expect(generationPrompt).toContain("必须优先引导本轮推文主题");
    expect(selectedMemoryBlock).not.toContain("在台北整理衣櫃");
  });

  it("injects saved tweet style profile as a fixed generation constraint", async () => {
    const created = await runPersonaWorkflow({
      action: "create",
      name: "固定風格人設",
      content: "一個會分享日常觀察的人設。",
      setup: {
        genres: ["生活觀察"],
        personaPersonality: "直覺",
        personaGender: "女性",
        personaStyle: "日常短評",
        totalEpisodes: 50,
        targetMarket: "cn",
        chineseScript: "traditional",
        tweetStyleProfile: "短句型；多段换行；结尾带轻互动；少量表情符号",
        linkEndingPresets: [{
          id: "preset-more",
          name: "更多整理",
          endingText: "想看更多整理，我放这里",
          linkUrl: "https://example.com/more",
          enabled: true,
        }],
        activeLinkEndingPresetId: "preset-more",
        tweetStyleSample: "最近发现咖啡店的冷气真的太强。\n\n坐十分钟，就开始怀疑自己是不是穿少了。\n你们也会这样吗？",
      },
    } as any);
    const archive = await loadPersonaArchive(created.archiveId);
    await savePersonaArchive({
      ...archive!,
      posts: [
        {
          id: "copied-style-sample-post",
          title: "污染草稿",
          content: "最近发现咖啡店的冷气真的太强。\n\n坐十分钟，就开始怀疑自己是不是穿少了。\n你们也会这样吗？",
          wordCount: 60,
          orderIndex: 0,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    } as any);

    const result = await runPersonaWorkflow({
      action: "generate-posts",
      archiveId: created.archiveId,
      count: 1,
    });

    const generationPrompt = prompts
      .filter((prompt) => prompt.includes("【固定推文风格】"))
      .at(-1) || "";

    expect(generationPrompt).toContain("【固定推文风格】");
    expect(generationPrompt).toContain("短句型；多段换行");
    expect(generationPrompt).not.toContain("咖啡店的冷气");
    expect(generationPrompt).not.toContain("你们也会这样吗");
    expect(generationPrompt).not.toContain("污染草稿");
    expect(generationPrompt).toContain("【固定链接结尾】");
    expect(generationPrompt).toContain("固定链接：https://example.com/more");
    expect(generationPrompt).toContain("结尾语句：想看更多整理，我放这里");
    expect(generationPrompt).toContain("禁止复述示例里的具体事件");
    expect(result.posts?.[0].content).toContain("想看更多整理，我放这里");
    expect(result.posts?.[0].content).toContain("https://example.com/more");
  });

  it("splits long multi-post generation into smaller batches", () => {
    expect(planPersonaPostGenerationBatches(10, 80)).toEqual([5, 5]);
    expect(planPersonaPostGenerationBatches(10, 120)).toEqual([3, 3, 3, 1]);
    expect(planPersonaPostGenerationBatches(10, 250)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(planPersonaPostGenerationBatches(10, 500)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});
