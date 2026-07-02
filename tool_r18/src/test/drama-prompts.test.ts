import { describe, expect, it } from "vitest";

import { buildCharactersPrompt, buildSocialPostsPrompt } from "@/lib/drama-prompts";

describe("buildSocialPostsPrompt", () => {
  it("forces meme image-first prompts to stay grounded in visual details", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["單身貴族"],
        personaPersonality: "幽默搞笑",
        personaGender: "不限",
        personaStyle: "幽默調侃",
        totalEpisodes: 150,
        targetMarket: "cn",
        isMemePersona: true,
      },
      "測試人設檔案",
      2,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      [
        { url: "data:image/png;base64,aaa", context: "粉兔子｜皺眉看手機｜白底表情包", source: "KnowYourMeme" },
        { url: "data:image/png;base64,bbb", context: "女生捂臉｜無語表情｜聊天截圖", source: "Reddit-memes" },
      ],
    );

    expect(prompt).toContain("圖片視覺描述/頁面線索");
    expect(prompt).toContain("至少點到一個具體視覺元素");
    expect(prompt).toContain("禁止脫離圖片另起話題");
    expect(prompt).toContain("粉兔子｜皺眉看手機｜白底表情包");
  });

  it("maps a 50-word base to the 50~150字 prompt range", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["单身贵族"],
        personaPersonality: "幽默搞笑",
        personaGender: "不限",
        personaStyle: "故事化表达",
        totalEpisodes: 50,
        targetMarket: "cn",
      },
      "测试人设档案",
      1,
    );

    expect(prompt).toContain("50~150字");
  });

  it("keeps 金君雅 on the short free-content hook template", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["飛行日常"],
        personaPersonality: "迷糊軟萌",
        personaGender: "女性",
        personaStyle: "繁體中文、台灣口語、甜感碎碎念、生活感強",
        personaName: "金君雅",
        contentTheme: "飛行日常、外站旅行、甜點、可愛穿搭",
        tweetStyleLinkUrl: "https://t.me/gy_night_flight_bot",
        freePostTemplate: "jinjunya-hook",
        totalEpisodes: 50,
        targetMarket: "cn",
        chineseScript: "traditional",
        isGirlPersona: true,
      },
      "金君雅人設",
      1,
    );

    expect(prompt).toContain("福利/美女傳播型人設");
    expect(prompt).toContain("剛洗完澡");
    expect(prompt).toContain("這條裙子穿出去");
  });

  it("does not force non-金君雅 girl personas into the short hook template", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["瑜伽"],
        personaPersonality: "溫柔體貼",
        personaGender: "女性",
        personaStyle: "繁體中文、台灣口語、溫柔、自律、療癒但不雞湯",
        personaName: "瑜伽老師",
        contentTheme: "瑜伽、伸展、體態管理、飲食、晨間習慣",
        totalEpisodes: 50,
        targetMarket: "cn",
        chineseScript: "traditional",
        isGirlPersona: true,
      },
      "瑜伽老師人設",
      1,
    );

    expect(prompt).not.toContain("福利/美女傳播型人設");
    expect(prompt).not.toContain("剛洗完澡");
    expect(prompt).not.toContain("這條裙子穿出去");
    expect(prompt).toContain("請生成 **1 篇**獨立完整的短文");
  });

  it("adds hard Taiwan locale guardrails when the persona is set to Taiwan", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["理財專家"],
        personaPersonality: "知性優雅",
        personaGender: "女性",
        personaNationality: "台灣",
        personaStyle: "實用內容分享",
        totalEpisodes: 150,
        targetMarket: "cn",
        chineseScript: "traditional",
      },
      "示例檔案裡曾提過 RM2,500 的報稅案例",
      1,
    );

    expect(prompt).toContain("目前帳號地區：台灣");
    expect(prompt).toContain("嚴禁出現：RM、MYR、令吉、馬幣");
    expect(prompt).toContain("人設國籍/地區：台灣");
    expect(prompt).toContain("如果參考內容和目前地區設定衝突");
  });

  it("adds regional local flavor and anti-AI voice rules for selected Taiwan personas", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["育兒媽媽"],
        personaPersonality: "貼近生活",
        personaGender: "女性",
        personaNationality: "台灣",
        personaStyle: "溫情敘事",
        totalEpisodes: 150,
        targetMarket: "cn",
        chineseScript: "traditional",
      },
      "台灣媽媽人設",
      1,
    );

    expect(prompt).toContain("地區煙火氣素材庫（台灣）");
    expect(prompt).toContain("Dcard");
    expect(prompt).toContain("小七取冰美式");
    expect(prompt).toContain("是在哈囉");
    expect(prompt).toContain("真人口吻硬約束");
    expect(prompt).toContain("人設腔調與專業度平衡");
    expect(prompt).toContain("同一地區的人設也不能寫成同一種口吻");
    expect(prompt).toContain("禁止 AI 腔");
  });

  it("uses country-specific SEA flavor when Singapore is selected", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["省錢達人"],
        personaPersonality: "幽默搞笑",
        personaGender: "不限",
        personaNationality: "新加坡",
        personaStyle: "幽默調侃",
        totalEpisodes: 150,
        targetMarket: "sea",
      },
      "Singapore savings persona",
      1,
    );

    expect(prompt).toContain("地區煙火氣素材庫（新加坡）");
    expect(prompt).toContain("hawker centre");
    expect(prompt).toContain("lah");
    expect(prompt).toContain("Singlish");
  });

  it("adds reusable regional slang requirements to persona profile generation", () => {
    const prompt = buildCharactersPrompt(
      {
        genres: ["美食創作者"],
        personaPersonality: "活潑開朗",
        personaGender: "女性",
        personaNationality: "日本",
        personaStyle: "故事化表達",
        totalEpisodes: 150,
        targetMarket: "jp",
        setupMode: "topic",
      },
      "",
    );

    expect(prompt).toContain("地區煙火氣素材庫（日本）");
    expect(prompt).toContain("コンビニ");
    expect(prompt).toContain("それな");
    expect(prompt).toContain("本機口頭禪/網路梗");
    expect(prompt).toContain("專業表達邊界");
    expect(prompt).toContain("禁用 AI 腔");
  });

  it("requires professional personas to keep expertise while using grounded language", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["理財專家"],
        personaPersonality: "知性優雅",
        personaGender: "女性",
        personaNationality: "中國大陸",
        personaStyle: "實用內容分享",
        totalEpisodes: 300,
        targetMarket: "cn",
      },
      "理財專家人設",
      1,
    );

    expect(prompt).toContain("貼近生活是表達方式，不是降低可信度");
    expect(prompt).toContain("俚語/熱梗只負責語氣和親近感，不能替代資訊量");
    expect(prompt).toContain("每篇至少給出一個具體判斷依據、經驗邊界、操作步驟或注意事項");
  });

  it("treats hot-topic context as multi-source intelligence rather than a flat trend blob", () => {
    const prompt = buildSocialPostsPrompt(
      {
        genres: ["美食創作者"],
        personaPersonality: "溫柔體貼",
        personaGender: "女性",
        personaNationality: "台灣",
        personaStyle: "故事化表達",
        totalEpisodes: 150,
        targetMarket: "cn",
        chineseScript: "traditional",
      },
      "台灣美食人設",
      1,
      undefined,
      0,
      undefined,
      undefined,
      "=== 美食創作者 ===\n【新聞與趨勢】\n便利商店新品聯名\n\n【社媒討論】\nThreads 上都在聊全家甜點\n\n【地區熱梗 / 網路語料】\n欸 真的假的 笑死",
    );

    expect(prompt).toContain("多源資訊情報（新聞 / 社媒 / 地區熱梗）");
    expect(prompt).toContain("通常會分成「新聞與趨勢」「社媒討論」「地區熱梗 / 網路語料」三段");
    expect(prompt).toContain("新聞與趨勢");
    expect(prompt).toContain("社媒討論");
    expect(prompt).toContain("地區熱梗 / 網路語料");
  });
});
