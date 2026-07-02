import { describe, expect, it } from "vitest";

import { buildPersonaImageQuery, buildPersonaSocialImagePrompt, getPersonaImageSignals, sanitizeImportedImagePool } from "@/lib/persona-image-search";

describe("getPersonaImageSignals", () => {
  it("detects meme personas from explicit meme flag", () => {
    const signals = getPersonaImageSignals({
      genres: ["情感創作者"],
      personaPersonality: "幽默搞笑",
      personaGender: "不限",
      personaStyle: "幽默調侃",
      totalEpisodes: 150,
      targetMarket: "cn",
      isMemePersona: true,
    });

    expect(signals.isMemeType).toBe(true);
    expect(signals.isGirlType).toBe(false);
  });

  it("detects girl personas from explicit girl flag", () => {
    const signals = getPersonaImageSignals({
      genres: ["單身貴族"],
      personaPersonality: "知性優雅",
      personaGender: "女性",
      personaStyle: "故事化表達",
      totalEpisodes: 150,
      targetMarket: "cn",
      personaDescription: "福利大姐姐，主打写真和气质自拍",
      isGirlPersona: true,
    });

    expect(signals.isGirlType).toBe(true);
    expect(signals.isMemeType).toBe(false);
  });

  it("keeps explicit girl personas out of meme mode even with humor style", () => {
    const signals = getPersonaImageSignals({
      genres: ["知心大姐姐"],
      personaPersonality: "幽默搞笑",
      personaGender: "女性",
      personaStyle: "幽默調侃",
      totalEpisodes: 150,
      targetMarket: "cn",
      personaDescription: "温柔知心大姐姐，主打自拍、写真和生活随拍",
      isGirlPersona: true,
    });

    expect(signals.isGirlType).toBe(true);
    expect(signals.isMemeType).toBe(false);
  });
});

describe("buildPersonaImageQuery", () => {
  it("injects meme-specific keywords for meme personas", () => {
    const { query } = buildPersonaImageQuery(
      "一天一梗图直到脱单，别进情侣区，直奔打折区。",
      {
        personaKeywords: "搞笑創作者",
        personaStyle: "幽默調侃",
        appearanceHint: "",
        isMemeType: true,
        isGirlType: false,
        isPersonaType: false,
      },
    );

    expect(query).toContain("梗圖");
    expect(query).toContain("meme");
    expect(query).toContain("shopping meme");
  });

  it("injects adult woman portrait cues for girl personas", () => {
    const { query } = buildPersonaImageQuery(
      "今天发一条咖啡店通勤自拍。",
      {
        personaKeywords: "福利大姐姐",
        personaStyle: "知性優雅 女性",
        appearanceHint: "adult woman, elegant hairstyle, city fashion outfit",
        isMemeType: false,
        isGirlType: true,
        isPersonaType: true,
      },
    );

    expect(query).toContain("adult woman portrait photo");
    expect(query).toContain("beauty lifestyle");
    expect(query).toContain("bikini swimwear editorial");
    expect(query).toContain("beach resort photography");
    expect(query).toContain("bathrobe hotel lifestyle");
    expect(query).toContain("towel hair vanity mirror");
  });

  it("anchors spiritual personas to their role instead of drifting to ads", () => {
    const { query } = buildPersonaImageQuery(
      "今天给大家讲一下最近桃花运怎么判断。",
      {
        personaKeywords: "算命創作者",
        personaStyle: "神秘高冷 女性",
        appearanceHint: "",
        isMemeType: false,
        isGirlType: false,
        isPersonaType: true,
      },
    );

    expect(query).toContain("tarot cards");
    expect(query).toContain("crystal ball");
    expect(query).toContain("-ad");
  });
});

describe("buildPersonaSocialImagePrompt", () => {
  it("builds a candid social-photo prompt instead of a live-event look", () => {
    const prompt = buildPersonaSocialImagePrompt(
      "剛剛下大雨還硬跑去全家領包裹，整個人超狼狽，結果店員小哥一直盯著我看。",
      {
        genres: [],
        personaPersonality: "知性優雅",
        personaGender: "女性",
        personaStyle: "故事化表達",
        totalEpisodes: 3,
        targetMarket: "cn",
        chineseScript: "traditional",
        personaAppearance: "25 歲女性，長直髮，設計感穿搭，保養精緻但保留手機拍照的真實感。",
        contentTheme: "美妝保養、穿搭、娛樂話題",
      },
      {
        personaKeywords: "美妝 穿搭",
        personaStyle: "知性優雅 女性",
        appearanceHint: "25 歲女性，長直髮，設計感穿搭，保養精緻但保留手機拍照的真實感。",
        isMemeType: false,
        isGirlType: false,
        isPersonaType: true,
      },
    );

    expect(prompt).toContain("convenience store");
    expect(prompt).toContain("rainy day");
    expect(prompt).toContain("candid iPhone-style capture");
    expect(prompt).toContain("not a livestream");
    expect(prompt).toContain("no sponsor wall");
  });
});

describe("sanitizeImportedImagePool", () => {
  it("drops obvious noisy assets from girl pools", () => {
    const filtered = sanitizeImportedImagePool(
      [
        "https://cdn.example.com/avatar_small.jpg",
        "https://cdn.example.com/flower-decor.png",
        "https://cdn.example.com/model-photo.jpg",
      ],
      "girl",
    );

    expect(filtered).toEqual(["https://cdn.example.com/model-photo.jpg"]);
  });
});
