import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { buildPersonaTrendTopics, buildPreferredNewsQueries, fetchPersonaTrendIntelForNode, headlineMatchesPersonaTopics, shanghaiDateKey } from "@/lib/persona-trend-intel-node";

describe("persona-trend-intel-node", () => {
  it("uses the Shanghai day for runtime cache keys", () => {
    expect(shanghaiDateKey(new Date("2026-07-31T16:30:00.000Z"))).toBe("2026-08-01");
    expect(shanghaiDateKey(new Date("2026-07-31T15:59:59.000Z"))).toBe("2026-07-31");
  });

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

  it("prioritizes the current post direction and persona core over broad genre labels", () => {
    const topics = buildPersonaTrendTopics({
      genres: ["搞笑", "生活日常"],
      targetMarket: "cn_tw",
      trendTopics: ["搞笑", "生活日常"],
      contentTheme: "髮型護理",
      interests: ["剪髮", "染髮"],
    } as any, "理髮師", {
      userInput: "第一次剪短髮，想知道怎麼跟理髮師溝通",
      selectedDirections: ["夏季短髮溝通"],
    });

    expect(topics[0]).toBe("夏季短髮溝通");
    expect(topics[1]).toBe("第一次剪短髮");
    expect(topics).toContain("想知道怎麼跟理髮師溝通");
    expect(topics).not.toContain("搞笑");
    expect(topics).not.toContain("生活日常");
  });

  it("builds recent Taiwan news searches around the persona topic and preferred publishers", () => {
    const queries = buildPreferredNewsQueries("房地產", {
      label: "台灣",
      hl: "zh-TW",
      gl: "TW",
      ceid: "TW:zh-Hant",
      suffix: "台灣 最新",
      socialTerms: "Threads Dcard PTT 台灣討論",
    });

    expect(queries).toHaveLength(2);
    expect(queries.join(" ")).toContain("房地產");
    expect(queries.join(" ")).toContain("site:money.udn.com");
    expect(queries.join(" ")).toContain("site:finance.ettoday.net");
    expect(queries.join(" ")).toContain("when:7d");
  });

  it("rejects preferred-source headlines that are unrelated to the persona topic", () => {
    expect(headlineMatchesPersonaTopics("央行揭房市管制三大變化", ["房市", "不動產政策"])).toBe(true);
    expect(headlineMatchesPersonaTopics("老宅都更與資產傳承四大課題", ["房市", "不動產政策"])).toBe(true);
    expect(headlineMatchesPersonaTopics("台積電先進製程營收創高", ["房市", "不動產政策"])).toBe(false);
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
    } as any, "persona-1", "台北吃貨", { timeoutMs: 2500, bypassCache: true });
    const second = await fetchPersonaTrendIntelForNode({
      genres: ["美食創作者"],
      targetMarket: "cn_tw",
      trendTopics: ["超商甜點"],
    } as any, "persona-1", "台北吃貨", { timeoutMs: 2500 });

    expect(first).toContain("人設相關新聞");
    expect(first).toContain("指定台灣新聞來源命中");
    expect(first).toContain("便利商店新品聯名爆紅");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("falls back to a general regional trend only when persona-related news is unavailable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("q") || "";
      const body = query.includes("台灣 最新")
        ? `<?xml version="1.0"?><rss><channel><item><title><![CDATA[全台今晚一起看流星雨 - 即時新聞]]></title></item></channel></rss>`
        : "<html><body>unrelated navigation</body></html>";
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPersonaTrendIntelForNode({
      genres: ["理髮師"],
      targetMarket: "cn_tw",
      trendTopics: ["剪髮"],
    } as any, "persona-general-fallback", "理髮師", { timeoutMs: 2500, bypassCache: true });

    expect(result).toContain("地區熱門話題");
    expect(result).toContain("全台今晚一起看流星雨");
    expect(result).toContain("能自然轉化為人設視角時才使用");
  });

  it("returns and caches an empty reference when no reliable headline matches", async () => {
    const fetchMock = vi.fn(async () => new Response("<html><body>unrelated navigation</body></html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchPersonaTrendIntelForNode({
      genres: ["房地產"],
      targetMarket: "cn_tw",
      trendTopics: ["房市"],
    } as any, "persona-no-news", "不動產顧問", { timeoutMs: 2500, bypassCache: true });
    const second = await fetchPersonaTrendIntelForNode({
      genres: ["房地產"],
      targetMarket: "cn_tw",
      trendTopics: ["房市"],
    } as any, "persona-no-news", "不動產顧問", { timeoutMs: 2500 });

    expect(first).toBe("");
    expect(second).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });
});
