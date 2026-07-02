import { describe, expect, it } from "vitest";
import { derivePersonaTopicSeeds } from "@/lib/persona-topic-seeds";
import type { DramaSetup } from "@/types/drama";

function setupInput(overrides: Partial<DramaSetup> = {}): DramaSetup {
  return {
    genres: [],
    personaPersonality: "知性優雅",
    personaGender: "女性",
    personaStyle: "實用內容分享",
    totalEpisodes: 3,
    targetMarket: "cn",
    setupMode: "topic",
    chineseScript: "traditional",
    ...overrides,
  };
}

describe("derivePersonaTopicSeeds", () => {
  it("prefers content themes and excludes persona names from intel queries", () => {
    const seeds = derivePersonaTopicSeeds(
      setupInput({
        personaName: "向婉婉",
        personaDescription: "美妝保養系社群女生，擅長用八卦和日常帶出互動。",
        contentTheme: "美妝保養、穿搭、娛樂話題、社群互動",
      }),
      "向婉婉",
    );

    expect(seeds).toEqual(["美妝保養", "穿搭", "娛樂話題"]);
  });

  it("prefers explicit trend topics over inferred text", () => {
    const seeds = derivePersonaTopicSeeds(
      setupInput({
        personaName: "向婉婉",
        personaDescription: "美妝保養系社群女生，擅長用八卦和日常帶出互動。",
        contentTheme: "美妝保養、穿搭、娛樂話題、社群互動",
        trendTopics: ["保濕保養", "開架彩妝", "藝人穿搭"],
      }),
      "向婉婉",
    );

    expect(seeds).toEqual(["保濕保養", "開架彩妝", "藝人穿搭"]);
  });

  it("keeps explicit genres unchanged", () => {
    const seeds = derivePersonaTopicSeeds(
      setupInput({
        genres: ["理財專家", "副業達人"],
        contentTheme: "工程師生活、科技、遊戲",
      }),
      "Jason JS",
    );

    expect(seeds).toEqual(["理財專家", "副業達人"]);
  });
});
