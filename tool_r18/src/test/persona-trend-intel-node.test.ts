import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { buildPersonaTrendTopics, fetchPersonaTrendIntelForNode } from "@/lib/persona-trend-intel-node";

describe("persona-trend-intel-node", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(resolveRuntimeFile("persona-trend-intel-cache.json"), { force: true });
    } catch {}
  });

  it("builds topic seeds from trend topics, genres and persona name", () => {
    const topics = buildPersonaTrendTopics({
      genres: ["美食創作者"],
      targetMarket: "cn_tw",
      trendTopics: ["超商甜點", "夜市"],
    } as any, "台北吃貨");

    expect(topics).toEqual(["超商甜點", "夜市", "美食"]);
  });

  it("fetches current trend intel and caches it for persona generation", async () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[便利商店新品聯名爆紅 - 測試新聞]]></title><source>測試新聞</source></item>
      <item><title><![CDATA[Threads 都在聊夜市排隊 - 測試社群]]></title><source>測試社群</source></item>
    </channel></rss>`;
    const fetchMock = vi.fn(async () => new Response(rss, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchPersonaTrendIntelForNode({
      genres: ["美食創作者"],
      targetMarket: "cn_tw",
      trendTopics: ["超商甜點"],
    } as any, "persona-1", "台北吃貨", { timeoutMs: 2500 });
    const second = await fetchPersonaTrendIntelForNode({
      genres: ["美食創作者"],
      targetMarket: "cn_tw",
      trendTopics: ["超商甜點"],
    } as any, "persona-1", "台北吃貨", { timeoutMs: 2500 });

    expect(first).toContain("新聞與趨勢");
    expect(first).toContain("便利商店新品聯名爆紅");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
