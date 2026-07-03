import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSummariesToMemory, deletePersonaMemoryEntry, getPersonaMemory, MAX_PERSONA_MEMORY_ENTRIES, replacePersonaMemoryEntries } from "@/lib/persona-memory";
import { addPostToMemory, buildMemoryOutline, buildMemoryThumbnail, deleteMemoryEntry, getMemoryEntries, normalizeMemorySummaryForStorage } from "@/lib/persona-memory-v2";

describe("persona memory deletion", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete (window as any).electronAPI;
  });

  it("deletes a local memory entry by preview id", async () => {
    addSummariesToMemory("persona-1", ["第一條記憶", "第二條記憶"]);

    const entries = await getMemoryEntries("persona-1");
    await deleteMemoryEntry("persona-1", entries[0]);

    expect(getPersonaMemory("persona-1").entries.map((entry) => entry.summary)).toEqual(["第二條記憶"]);
  });

  it("deletes a local memory entry by content selector", () => {
    addSummariesToMemory("persona-2", ["保留的記憶", "要刪除的記憶"]);

    const deleted = deletePersonaMemoryEntry("persona-2", {
      date: getPersonaMemory("persona-2").entries[1].date,
      summary: "要刪除的記憶",
    });

    expect(deleted).toBe(true);
    expect(getPersonaMemory("persona-2").entries.map((entry) => entry.summary)).toEqual(["保留的記憶"]);
  });

  it("keeps only the newest 100 memory entries", async () => {
    const entries = Array.from({ length: MAX_PERSONA_MEMORY_ENTRIES + 5 }, (_item, index) => ({
      id: `memory-${index}`,
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      summary: `memory summary ${index}`,
    }));

    await replacePersonaMemoryEntries("persona-trim-limit", entries);

    const stored = getPersonaMemory("persona-trim-limit").entries;
    expect(stored).toHaveLength(MAX_PERSONA_MEMORY_ENTRIES);
    expect(stored.map((entry) => entry.id)).not.toContain("memory-0");
    expect(stored.map((entry) => entry.id)).not.toContain("memory-4");
    expect(stored.map((entry) => entry.id)).toContain(`memory-${MAX_PERSONA_MEMORY_ENTRIES + 4}`);
  });

  it("extracts key tweet points instead of only keeping the opening line", () => {
    const post = "最近看到專家對 2026 年中產資產配置的建議，我超有感觸！現在一個便當隨便都要破百，健保費可能又要調，生活成本根本回不去了。如果你還在猶豫要不要開始做理財規劃，我只能說：現在就是最好的時機。與其去研究那些聽不懂的複雜產品，不如先把現金流、保險缺口、緊急預備金整理好。";

    const outline = buildMemoryOutline(post);

    expect(outline).toContain("中產資產配置");
    expect(outline).toMatch(/生活成本|健保費|便當/);
    expect(outline).toMatch(/現金流|保險缺口|緊急預備金/);
    expect(outline).not.toBe("最近看到專家對 2026 年中產資產配置的建議，我超有感觸");
    expect(outline.length).toBeLessThanOrEqual(111);
  });

  it("filters model scratch text out of memory outlines", () => {
    const outline = buildMemoryOutline("主題：外站過夜換個地方賴床；補充：**Defining the Objective** I'm zeroing in on the core request: distilling a social media post into a long-term memory summary.");

    expect(outline).toBe("主題：外站過夜換個地方賴床");
    expect(outline).not.toMatch(/Defining|Objective|long-term memory/i);
  });

  it("compacts legacy verbose summaries into core memory for display", () => {
    const summary = normalizeMemorySummaryForStorage("2026-05-31 **Defining the Objective** I'm currently dissecting the request. 主題：看新聞說2026機票要大漲，重點：她擔心外站票越來越貴，想把買票策略改成提前比價與避開旺季。補充：approximately 80 words, fitting the persona.");

    expect(summary).toContain("機票");
    expect(summary).toMatch(/提前比價|避開旺季|外站票/);
    expect(summary).not.toMatch(/Defining|Objective|approximately|persona|word/i);
    expect(summary.length).toBeLessThanOrEqual(72);
  });

  it("stores only concise core memories when adding summaries", async () => {
    addSummariesToMemory("persona-compact", [
      "主題：新聞都在說機票要漲價大家瘋搶外站票，然後她開始反思旅遊預算不能再隨便刷卡；重點：未來買票要提前比價、避開旺季、把交通預算先存好；補充：這段原本很長很長不應該整段塞進按鈕",
    ]);

    const [entry] = await getMemoryEntries("persona-compact");
    expect(entry.summary).toMatch(/機票|買票|旅遊預算/);
    expect(entry.summary.length).toBeLessThanOrEqual(72);
    expect(entry.summary).not.toContain("這段原本很長很長");
  });

  it("filters prompt compliance fragments out of structured memory outlines", () => {
    const outline = buildMemoryOutline("主題：你們覺得穿這樣出門會太誇張嗎；補充：approximately 60 Taiwanese Mandarin words, fitting the persona of Kim Junya. The word count is good.");

    expect(outline).toBe("主題：你們覺得穿這樣出門會太誇張嗎");
    expect(outline).not.toMatch(/approximately|persona|word count/i);
  });

  it("keeps memory preview outlines from cutting key points mid-sentence", async () => {
    const post = "手搖飲漲價現象，台南巷口名店加料鮮奶茶售價已超越排骨便當，反映通膨對庶民生活的壓力。店家把鮮奶、茶葉、房租與人力成本一起調整，消費者開始改買無糖茶或減少加料。建議觀察客單價與回購頻率，而不是只看排隊人潮。";
    const thumbnail = buildMemoryThumbnail(post);
    const outline = buildMemoryOutline(post);

    addSummariesToMemory("persona-preview", [outline]);
    const [entry] = await getMemoryEntries("persona-preview");

    expect(thumbnail).toContain("台南巷口名店");
    expect(thumbnail).toContain("庶民生活");
    expect(thumbnail).not.toContain("對庶民...");
    expect(entry.summary.length).toBeLessThanOrEqual(72);
    expect(entry.summary).toContain("庶民生活");
  });

  it("sends the full post to Electron memory extraction", async () => {
    const post = "第一句只是開場。真正重點是台灣家庭要把醫療費、保險缺口和緊急預備金一起盤點。";
    const addEntry = vi.fn().mockResolvedValue({ ok: true });
    (window as any).electronAPI = {
      memory: { addEntry },
    };

    await addPostToMemory("persona-electron", post, "理財人設");

    expect(addEntry).toHaveBeenCalledWith({
      personaId: "persona-electron",
      personaName: "理財人設",
      postContent: post,
    });
  });
});
