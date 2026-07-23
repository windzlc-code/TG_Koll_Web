import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSentimentCandidateId,
  getSentimentHotExcludedIds,
  getSentimentHotRefreshExcludedIds,
  getSentimentHotShownHistoryKeys,
  rememberSentimentHotImported,
  rememberSentimentHotSelected,
  rememberSentimentHotShown,
} from "@/lib/sentiment-candidate-store";
import {
  analyzeThreadsProfileVisibleSignals,
  applyPersonaGuardToSentimentHotStrategy,
  buildSentimentHotKeywords,
  buildJinaReaderUrl,
  buildThreadsSearchUrl,
  candidateMatchesRequestedFreshness,
  candidateMatchesSentimentHotStrategyAnchors,
  candidateMatchesCurrentKeywords,
  cleanSentimentCandidateContent,
  enrichThreadsCandidateDetails,
  finalizeSentimentHotCandidatesForDisplay,
  isObviouslyLowQualitySentimentHotCandidate,
  isChineseSentimentCandidate,
  parseInstagramReaderSearchMarkdownCandidates,
  matchThreadsBrowserProfilePublishedPost,
  parseThreadsBrowserPostDetailMetrics,
  parseThreadsBrowserProfilePublishedPosts,
  parseThreadsGraphqlSearchPayload,
  parseThreadsGraphqlSearchPageInfo,
  parseThreadsGraphqlProfilePagePayload,
  normalizeThreadsRelativeTime,
  normalizeSentimentHotFreshnessDays,
  normalizeSentimentHotFreshnessPolicy,
  orderSentimentHotCandidatesForLegacyFallback,
  isSentimentHotCandidateRepeatEligible,
  parseThreadsPostViewCountFromText,
  parseThreadsReaderSearchMarkdownCandidates,
  parseThreadsDetailEngagementMarkdown,
  parseThreadsDetailMediaMarkdown,
  parseThreadsSearchTextCandidates,
  refreshSentimentSourceMetrics,
  resolveSentimentHotStrategyTimeoutMs,
  shouldTreatThreadsProfileAsLoginWall,
} from "@/lib/sentiment-hot-importer";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sentiment hot importer", () => {
  it("builds a valid Jina Reader URL for HTTPS Threads pages", () => {
    expect(buildJinaReaderUrl("https://www.threads.com/search?q=tea")).toBe(
      "https://r.jina.ai/http://www.threads.com/search?q=tea",
    );
  });

  it("uses Threads recent search only for freshness-scoped fetches", () => {
    expect(buildThreadsSearchUrl("tea")).toBe("https://www.threads.com/search?q=tea");
    expect(buildThreadsSearchUrl("茶文化", true)).toBe(
      "https://www.threads.com/search?q=%E8%8C%B6%E6%96%87%E5%8C%96&filter=recent",
    );
  });

  it("clamps custom freshness to fifteen days", () => {
    expect(normalizeSentimentHotFreshnessDays(0)).toBe(0);
    expect(normalizeSentimentHotFreshnessDays(7)).toBe(7);
    expect(normalizeSentimentHotFreshnessDays(15)).toBe(15);
    expect(normalizeSentimentHotFreshnessDays(30)).toBe(15);
  });

  it("keeps freshness policy explicit so strict tests cannot silently use legacy backfill", () => {
    expect(normalizeSentimentHotFreshnessPolicy("strict")).toBe("strict");
    expect(normalizeSentimentHotFreshnessPolicy("legacy")).toBe("legacy");
    expect(normalizeSentimentHotFreshnessPolicy("unknown")).toBe("legacy");
  });

  it("prioritizes unshown legacy candidates before rotating shown history", () => {
    const archiveId = `test-legacy-rotation-${Date.now()}`;
    const shown = {
      id: "legacy-shown",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/legacy-shown",
      author: "demo",
      content: "這是一條已經展示過的金融理財經驗分享內容，包含足夠的中文內容。",
      media: [],
      hotScore: 5000,
      metrics: {},
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    } as any;
    const fresh = {
      ...shown,
      id: "legacy-fresh",
      sourceUrl: "https://www.threads.net/@demo/post/legacy-fresh",
      content: "這是一條尚未展示的金融理財經驗分享內容，應該優先出現在候選列表。",
    } as any;
    rememberSentimentHotShown(archiveId, [shown]);
    const ordered = orderSentimentHotCandidatesForLegacyFallback([shown, fresh], archiveId);
    expect(ordered.map((candidate) => candidate.id)).toEqual(["legacy-fresh", "legacy-shown"]);
  });

  it("keeps heat and length gates hard while rotating shown candidates after cooldown", () => {
    const archiveId = `test-repeat-cooldown-${Date.now()}`;
    const shown = {
      id: "repeatable-hot",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/repeatable-hot",
      author: "demo",
      content: "這是一段已展示過但仍符合主題的金融理財經驗分享，包含足夠的中文內容和完整背景說明。",
      media: [],
      hotScore: 5000,
      metrics: { source: "threads-reader-search" },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    } as any;
    const belowHeat = { ...shown, id: "below-heat", hotScore: 999 } as any;
    const belowLength = { ...shown, id: "below-length", content: "金融理財" } as any;
    rememberSentimentHotShown(archiveId, [shown]);

    expect(isSentimentHotCandidateRepeatEligible(shown, archiveId, { now: Date.now() })).toBe(false);
    const afterCooldown = Date.now() + 6 * 60 * 60 * 1000 + 1;
    expect(isSentimentHotCandidateRepeatEligible(shown, archiveId, { now: afterCooldown })).toBe(true);
    expect(orderSentimentHotCandidatesForLegacyFallback([shown], archiveId, {
      allowShownRepeat: true,
      now: afterCooldown,
    }).map((candidate) => candidate.id)).toEqual(["repeatable-hot"]);
    expect(finalizeSentimentHotCandidatesForDisplay([belowHeat, belowLength], 10, {
      keywords: ["金融理財"],
      searchMode: "normal",
    })).toEqual([]);
  });

  it("keeps a live refresh from consuming the browser stage with model strategy time", () => {
    expect(resolveSentimentHotStrategyTimeoutMs(true, 50_000)).toBe(18_000);
    expect(resolveSentimentHotStrategyTimeoutMs(false, 50_000)).toBe(30_000);
    expect(resolveSentimentHotStrategyTimeoutMs(true, 5_000)).toBe(5_000);
  });

  it("does not change the source pipeline when custom freshness is disabled", () => {
    const candidate = {
      id: "unknown-date",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/unknown-date",
      author: "demo",
      content: "Test candidate without a published timestamp.",
      media: [],
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    } as any;

    expect(candidateMatchesRequestedFreshness(candidate, 0)).toBe(true);
    expect(candidateMatchesRequestedFreshness(candidate, undefined)).toBe(true);
    expect(candidateMatchesRequestedFreshness(candidate, 7)).toBe(false);
    expect(candidateMatchesRequestedFreshness({
      ...candidate,
      metrics: { archiveScopedFallback: true },
    } as any, 0)).toBe(true);
    expect(candidateMatchesRequestedFreshness({
      ...candidate,
      metrics: { archiveScopedFallback: true },
    } as any, 7)).toBe(false);
  });

  it("builds persona-specific search keywords", () => {
    const beautyKeywords = buildSentimentHotKeywords({
      archive: {
        id: "beauty",
        name: "Beauty Persona",
        content: "分享护肤 穿搭 生活日常。",
        setup: { genres: ["护肤", "穿搭"], contentTheme: "生活" },
        posts: [],
      } as any,
    });
    const techKeywords = buildSentimentHotKeywords({
      archive: {
        id: "tech",
        name: "Tech Persona",
        content: "分享AI工具和自动化流程。",
        setup: { genres: ["AI", "自动化"], contentTheme: "效率" },
        posts: [],
      } as any,
    });

    expect(beautyKeywords).toContain("护肤");
    expect(techKeywords).toContain("自动化");
    expect(beautyKeywords.join("|")).not.toBe(techKeywords.join("|"));
  });

  it("turns fictional persona descriptions into searchable Chinese topic keywords", () => {
    const keywords = buildSentimentHotKeywords({
      archive: {
        id: "liwu",
        name: "李无",
        content: "李无是一位邪恶医生，黑暗医疗视频倾向，内容领域聚焦医疗阴谋、邪恶实验与黑色幽默故事。",
        setup: { genres: ["医疗黑暗", "邪恶医生故事"], contentTheme: "医院反派故事" },
        posts: [],
      } as any,
    });

    expect(keywords).not.toContain("李无");
    expect(keywords).toEqual(expect.arrayContaining(["医疗黑暗", "邪恶医生故事", "邪恶实验"]));
    expect(keywords).not.toContain("醫療");
    expect(keywords).not.toContain("医生");
  });

  it("does not promote visual field labels or negated topics into hot search keywords", () => {
    const keywords = buildSentimentHotKeywords({
      archive: {
        id: "ken",
        name: "Ken 海外工薪金融干货",
        content: "面向海外工薪族，分享海外金融、工薪信貸、理財規劃、信用卡和贷款。不做美食娛樂。",
        setup: {
          genres: ["AI", "人工智慧", "自動化", "職場", "海外金融", "工薪信貸", "理財規劃"],
          contentTheme: "內容主題和圖片視覺傾向",
          personality: "理性務實",
        },
        posts: [],
      } as any,
    });

    expect(keywords).toEqual(expect.arrayContaining(["海外金融", "工薪信貸", "理財規劃"]));
    expect(keywords).not.toContain("內容主題");
    expect(keywords).not.toContain("圖片視覺傾向");
    expect(keywords).not.toContain("視覺傾向");
    expect(keywords).not.toContain("理性務實");
    expect(keywords).not.toContain("美食");
  });

  it("does not directly use interest tags as fallback hot search keywords", () => {
    const keywords = buildSentimentHotKeywords({
      archive: {
        id: "interest-drift",
        name: "海外工薪理財號",
        content: "面向海外工薪族，專注工薪信貸、信用卡、貸款和理財規劃。",
        setup: {
          interests: ["美食", "旅行"],
          genres: ["海外金融"],
          personaType: "海外工薪金融干貨",
        },
        posts: [],
      } as any,
    });

    expect(keywords).toEqual(expect.arrayContaining(["工薪信貸", "信用卡", "貸款", "理財規劃"]));
    expect(keywords).not.toContain("美食");
    expect(keywords).not.toContain("旅行");
  });

  it("does not leak Traditional Chinese persona wrapper phrases into fallback hot keywords", () => {
    const keywords = buildSentimentHotKeywords({
      archive: {
        id: "ken-real",
        name: "Ken 海外工薪金融干货",
        content: "Ken 是一名海外工薪金融干货人设，說話直白犀利，深耕海外華人工薪信貸與理財規劃。",
        setup: {
          genres: ["海外金融", "工薪信貸", "理財規劃"],
          personality: "說話直白犀利",
          personaType: "海外工薪金融干货",
        },
        posts: [],
      } as any,
    });

    expect(keywords).toEqual(expect.arrayContaining(["海外金融", "工薪信貸", "理財規劃"]));
    expect(keywords).not.toContain("是一名");
    expect(keywords).not.toContain("他自詡為");
    expect(keywords).not.toContain("說話直白犀利");
    expect(keywords).not.toContain("深耕海外華人工薪信貸");
  });

  it("rejects hot candidates that conflict with the persona topic", () => {
    const medicalKeywords = ["醫療", "医生", "醫院", "黑心医生"];
    const beautyCandidate = {
      id: "beauty-1",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/beauty",
      author: "beauty",
      content: "今天穿搭真的被問爆，護膚和美妝都整理好了，女生拍照角度分享給你們。",
      media: [],
      hotScore: 9000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    } as const;
    const medicalCandidate = {
      ...beautyCandidate,
      id: "medical-1",
      sourceUrl: "https://www.threads.net/@demo/post/medical",
      author: "doctor",
      content: "急診醫生分享醫療現場，最近醫院化驗流程和病人等待時間又被討論。",
    } as const;

    expect(candidateMatchesCurrentKeywords(beautyCandidate, medicalKeywords)).toBe(false);
    expect(candidateMatchesCurrentKeywords(medicalCandidate, medicalKeywords)).toBe(true);
  });

  it("does not let weak generic words pass by themselves", () => {
    const keywords = ["醫療", "医生", "分享", "日常"];
    const genericCandidate = {
      id: "generic-1",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic",
      author: "daily",
      content: "今天日常分享一下最近心情，生活裡的小事也可以很有共鳴。",
      media: [],
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    } as const;

    expect(candidateMatchesCurrentKeywords(genericCandidate, keywords)).toBe(false);
  });

  it("keeps strongly matched candidates for model-level persona judgment", () => {
    const keywords = ["醫療", "醫生", "黑色幽默"];
    const candidate = {
      id: "mixed-1",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/mixed",
      author: "daily",
      content: "醫生朋友用黑色幽默吐槽醫療現場，也聊到今天自拍和生活碎片。",
      media: [],
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    } as const;

    expect(candidateMatchesCurrentKeywords(candidate, keywords)).toBe(true);
  });

  it("keeps model-generated Latin domain terms in strict relevance matching", () => {
    const candidate = {
      id: "cosplay-strict",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/cosplay-strict",
      author: "demo",
      content: "這次 Cosplay 角色扮演整理了服裝製作、妝容調整、道具修補和展場互動心得，也分享拍攝前準備與現場避坑方式，內容完整且直接屬於人設主領域。",
      media: [],
      hotScore: 1000,
      metrics: { source: "threads-search-page" },
      capturedAt: new Date().toISOString(),
    };

    expect(candidateMatchesCurrentKeywords(candidate as any, ["刺青 cosplay", "cosplay"], "strict")).toBe(true);
    expect(finalizeSentimentHotCandidatesForDisplay([candidate] as any, 10, {
      keywords: ["刺青 cosplay", "cosplay"],
      searchMode: "strict",
    }).map((item) => item.id)).toEqual(["cosplay-strict"]);
  });

  it("does not treat a generic live-stream word as strict persona relevance", () => {
    const genericLive = {
      id: "generic-live",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic-live",
      author: "demo",
      content: "这个直播从哪里开始可以免费看？大家知道入口吗？",
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    };
    const gameLive = {
      ...genericLive,
      id: "game-live",
      sourceUrl: "https://www.threads.net/@demo/post/game-live",
      content: "今晚的游戏直播会复盘职业联赛战术，重点分析队伍阵容和地图选择。",
    };

    expect(candidateMatchesCurrentKeywords(genericLive as any, ["直播", "游戏直播"], "strict")).toBe(false);
    expect(candidateMatchesCurrentKeywords(gameLive as any, ["直播", "游戏直播"], "strict")).toBe(true);
  });

  it("matches Traditional Chinese posts against Simplified Chinese model terms in strict mode", () => {
    const candidate = {
      id: "traditional-auto-repair",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@garage/post/traditional-auto-repair",
      author: "garage",
      content: "請問泡水車的汽車維修費用大概多少，想找可靠的保養廠檢查底盤。",
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    };

    expect(candidateMatchesCurrentKeywords(candidate as any, ["汽车维修", "车辆保养"], "strict")).toBe(true);
  });

  it("keeps daily-life posts only when they still match persona keywords", () => {
    const base = {
      platform: "threads",
      media: [],
      hotScore: 9000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    };
    const keywords = ["海外金融", "工薪信貸", "信用卡"];
    const genericDaily = {
      ...base,
      id: "generic-daily",
      sourceUrl: "https://www.threads.net/@demo/post/generic-daily",
      author: "daily",
      content: "今天想分享一點日常生活，最近和朋友聊天聊到心情、工作節奏、吃飯散步和週末安排，大家都說生活有時候就是慢慢調整，找到舒服的方式就好。",
    };
    const personaDaily = {
      ...base,
      id: "persona-daily",
      sourceUrl: "https://www.threads.net/@demo/post/persona-daily",
      author: "finance",
      content: "今天想分享海外工薪族的日常理財壓力，很多人一邊處理信用卡週轉，一邊比較銀行貸款和信貸利率，生活開銷、收入證明、還款節奏都會影響後續規劃。",
    };

    expect(candidateMatchesCurrentKeywords(genericDaily as any, keywords)).toBe(false);
    expect(candidateMatchesCurrentKeywords(personaDaily as any, keywords)).toBe(true);
    expect(finalizeSentimentHotCandidatesForDisplay([genericDaily as any, personaDaily as any], 10, { keywords })
      .map((candidate) => candidate.id)).toEqual(["persona-daily"]);
  });

  it("filters obvious low-quality hot candidates before display", () => {
    const base = {
      id: "candidate",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/abc",
      author: "demo",
      media: [],
      hotScore: 9000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    } as const;
    const keywords = ["海外金融", "工薪信貸", "信用卡"];

    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "Threads Log in Join Threads to share ideas and random thoughts.",
    } as any, keywords)).toBe(true);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "海外金融",
    } as any, keywords)).toBe(true);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "海外金融信用卡限時優惠私訊下單領券，今天購買還有折扣和贈品。",
    } as any, keywords)).toBe(true);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "海外金融信用卡限時優惠整理，這次比較不同銀行的回饋比例、年費門檻、海外刷卡手續費、分期利率和還款規則，也提醒工薪族不要只看折扣，還要評估現金流和信用評分影響，避免為了短期回饋拉高長期負債。",
    } as any, keywords)).toBe(false);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "海外工薪族最近都在討論信用卡額度和信貸利率，銀行審核變嚴後，理財規劃和現金流安排變得更重要。有人分享先整理負債比例、收入證明與固定支出，再決定是否申請信貸，這種案例很適合改寫成務實提醒。",
    } as any, keywords)).toBe(false);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "剛有房貸 再去信貸 信貸利率會落在多少？",
    } as any, ["海外信貸", "工薪信貸", "貸款利率"])).toBe(true);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "看新聞最近銀行都快沒錢了，信貸專員說這陣子太多人申請，所以利率很高，有人整理銀行審核和貸款利率的真實經驗，也補充收入證明、負債比和還款規劃會影響最後核准條件，提醒工薪族先算清楚每月現金流。",
    } as any, ["海外信貸", "銀行風控", "貸款利率"])).toBe(false);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "科技公司最近釋出大量招聘職缺，前端工程師和資料分析師都開始比較薪資條件與面試流程。有人整理履歷作品集、筆試題型、遠端工作比例和薪資談判方式，對職場型人設來說有明確觀點和改寫價值。",
    } as any, ["招聘職缺", "前端工程師", "面試流程"])).toBe(false);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "牡羊座下半年運勢開始重新定位人生方向，工作感情和居住選擇都會變得更清楚，還會開始思考財務規劃和信用卡使用。",
    } as any, ["海外信貸", "工薪信貸", "理財規劃"])).toBe(true);
    expect(isObviouslyLowQualitySentimentHotCandidate({
      ...base,
      content: "女仔望過嚟，過來人警世，唔好太快同居，一定要帶套，問你借錢就原地分手，人工和存款都不要太快讓對方知道。",
    } as any, ["海外信貸", "工薪信貸", "借錢"])).toBe(true);
  });

  it("sorts final hot candidates by heat and removes duplicates before display", () => {
    const base = {
      platform: "threads",
      author: "demo",
      capturedAt: new Date().toISOString(),
      media: [],
      metrics: {},
    } as const;
    const duplicateContent = "海外工薪族最近都在討論信用卡額度和信貸利率，銀行審核變嚴後，理財規劃和現金流安排變得更重要。有人分享先整理負債比例、收入證明與固定支出，再決定是否申請信貸，這種案例很適合改寫成務實提醒。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        ...base,
        id: "low",
        sourceUrl: "https://www.threads.net/@demo/post/low",
        content: "海外金融信用卡和貸款利率最近討論不少，很多工薪族會先比較銀行審核和現金流，再決定是否申請信貸。這類內容雖然熱度較低，但資訊量足夠，仍可作為排序測試裡的有效候選，也能提醒不要盲目追額度。",
        hotScore: 5000,
      },
      {
        ...base,
        id: "duplicate-a",
        sourceUrl: "https://www.threads.net/@demo/post/a?utm_source=test",
        content: duplicateContent,
        hotScore: 12000,
      },
      {
        ...base,
        id: "duplicate-b",
        sourceUrl: "https://www.threads.net/@other/post/b",
        content: duplicateContent,
        hotScore: 18000,
      },
      {
        ...base,
        id: "top",
        sourceUrl: "https://www.threads.net/@demo/post/top",
        content: "海外信貸市場最近熱度很高，信用卡週轉、銀行貸款和利率審核都被反覆討論。有人把申請資料、負債比和收入證明整理成清單，提醒工薪族不要只看額度，也要看還款節奏和風險，尤其要先確認穩定薪資流水。",
        hotScore: 30000,
      },
    ] as any, 10);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["top", "duplicate-b", "low"]);
    expect(candidates.map((candidate) => candidate.hotScore)).toEqual([30000, 18000, 5000]);
  });

  it("excludes previewed posts and URL variants on the next refresh", () => {
    const archiveId = `test-refresh-exclude-shown-${Date.now()}`;
    const base = {
      platform: "threads",
      author: "demo",
      capturedAt: new Date().toISOString(),
      media: [],
      metrics: {},
    } as const;
    const shown = {
      ...base,
      id: "shown-hot",
      sourceUrl: "https://www.threads.net/@demo/post/shown-hot",
      content: "海外信貸市場最近很多人討論信用卡周轉和銀行貸款審核，這篇雖然熱度最高，但已經在上一輪展示過。刷新抓取時不應再拿它回補，避免使用者一直看到同一篇內容，應該依靠新的搜尋候選補足剩餘數量。",
      hotScore: 90000,
    };
    const fresh = {
      ...base,
      id: "fresh-hot",
      sourceUrl: "https://www.threads.net/@demo/post/fresh-hot",
      content: "海外信貸族群最近開始整理收入證明、負債比例和固定支出，再比較信用卡分期、銀行貸款與貸款利率。這種內容和人設關鍵詞高度相關，而且沒有被展示過，刷新時應該優先出現在候選列表。",
      hotScore: 30000,
    };
    const shownUrlVariant = {
      ...shown,
      id: "shown-url-variant",
      sourceUrl: "https://www.threads.com/@demo/post/shown-hot?xmt=AQG-test#reply",
      content: `${shown.content} 這是另一個抓取渠道回傳的同一原帖。`,
    };

    rememberSentimentHotShown(archiveId, [shown] as any);
    const shownHistory = getSentimentHotShownHistoryKeys(archiveId);
    expect(shownHistory.has("id:shown-hot")).toBe(true);
    expect(shownHistory.has("url:https://threads.net/@demo/post/shown-hot")).toBe(true);
    const candidates = finalizeSentimentHotCandidatesForDisplay([shown, shownUrlVariant, fresh] as any, 10, {
      archiveId,
      keywords: ["海外信貸", "銀行貸款", "信用卡"],
      excludeShown: true,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["fresh-hot"]);
    const limitedCandidates = finalizeSentimentHotCandidatesForDisplay([shown, fresh] as any, 1, {
      archiveId,
      keywords: ["海外信貸", "銀行貸款", "信用卡"],
      excludeShown: true,
    });
    expect(limitedCandidates.map((candidate) => candidate.id)).toEqual(["fresh-hot"]);
    expect(getSentimentHotExcludedIds(archiveId).has("shown-hot")).toBe(false);
    expect(getSentimentHotRefreshExcludedIds(archiveId).has("shown-hot")).toBe(true);
  });

  it("only excludes a candidate after its draft import succeeds", () => {
    const archiveId = `test-import-consumption-${Date.now()}`;
    rememberSentimentHotSelected(archiveId, "candidate-a");
    expect(getSentimentHotExcludedIds(archiveId).has("candidate-a")).toBe(false);

    rememberSentimentHotImported(archiveId, "candidate-a");
    expect(getSentimentHotExcludedIds(archiveId).has("candidate-a")).toBe(true);
  });

  it("keeps older high-heat candidates behind fresh candidates for gap filling", () => {
    const content = "海外信貸市場最近整理信用卡週轉、銀行貸款、收入證明和負債比例，內容包含完整申請流程、利率比較、還款安排與風險提醒，適合金融人設改寫成實用推文。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "old-hot",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@demo/post/old-hot",
        author: "demo",
        content,
        media: [],
        hotScore: 90000,
        metrics: {},
        publishedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        capturedAt: new Date().toISOString(),
      },
      {
        id: "fresh-hot-30d",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@demo/post/fresh-hot-30d",
        author: "demo",
        content: `${content} 這篇是本週新增討論。`,
        media: [],
        hotScore: 30000,
        metrics: {},
        publishedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
      },
    ] as any, 10, { keywords: ["海外信貸", "銀行貸款", "信用卡"] });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["fresh-hot-30d", "old-hot"]);
  });

  it("filters candidates by the requested freshness window", () => {
    const now = Date.now();
    const content = "\u4fe1\u7528\u5361\u8d37\u6b3e\u5229\u7387\u4e0e\u94f6\u884c\u8fd8\u6b3e\u89c4\u5212\u662f\u5de5\u85aa\u65cf\u7406\u8d22\u7684\u91cd\u8981\u8bdd\u9898\uff0c\u9700\u8981\u6bd4\u8f83\u73b0\u91d1\u6d41\u3001\u8d1f\u503a\u6bd4\u548c\u957f\u671f\u6210\u672c\u3002".repeat(2);
    const candidate = (id: string, publishedAt?: string) => ({
      id,
      platform: "threads",
      sourceUrl: `https://www.threads.net/@finance/post/${id}`,
      author: "finance",
      content,
      media: [],
      hotScore: 5000,
      metrics: {},
      ...(publishedAt ? { publishedAt } : {}),
      capturedAt: new Date(now).toISOString(),
    });

    const candidates = finalizeSentimentHotCandidatesForDisplay([
      candidate("recent", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()),
      candidate("old", new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()),
      candidate("unknown"),
    ] as any, 10, { freshnessDays: 7 });

    expect(candidates.map((item) => item.id)).toEqual(["recent"]);
  });

  it("rejects an old same-persona fallback even when it was captured recently", () => {
    const now = Date.now();
    const content = "\u4fe1\u7528\u5361\u8d37\u6b3e\u5229\u7387\u4e0e\u94f6\u884c\u8fd8\u6b3e\u89c4\u5212\u662f\u5de5\u85aa\u65cf\u7406\u8d22\u7684\u91cd\u8981\u8bdd\u9898\uff0c\u9700\u8981\u6bd4\u8f83\u73b0\u91d1\u6d41\u3001\u8d1f\u503a\u6bd4\u548c\u957f\u671f\u6210\u672c\u3002".repeat(2);
    const candidates = finalizeSentimentHotCandidatesForDisplay([{
      id: "recent-fallback-cache",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@finance/post/recent-fallback-cache",
      author: "finance",
      content,
      media: [],
      hotScore: 5000,
      metrics: { archiveScopedFallback: true },
      publishedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      capturedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    }] as any, 10, { freshnessDays: 15 });

    expect(candidates).toEqual([]);
  });

  it("prioritizes a fresher unshown candidate over a hotter older candidate", () => {
    const now = Date.now();
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "older-higher-heat",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@finance/post/older-higher-heat",
        author: "finance",
        content: "海外金融市場近期持續討論信用卡週轉、銀行信貸與貸款利率，有人整理收入證明、負債比例、每月還款安排和現金流風險，提醒工薪族申請前先比較審核條件與總成本。",
        media: [],
        hotScore: 9000,
        metrics: {},
        publishedAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
        capturedAt: new Date(now).toISOString(),
      },
      {
        id: "recent-lower-heat",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@finance/post/recent-lower-heat",
        author: "finance",
        content: "海外工薪族今天分享銀行貸款與信用卡整合經驗，完整比較信貸利率、收入證明、負債比例、還款期限和每月現金流，提醒申請額度前先確認審核規則與長期還款壓力。",
        media: [],
        hotScore: 1000,
        metrics: {},
        publishedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        capturedAt: new Date(now).toISOString(),
      },
    ] as any, 10, {
      archiveId: `test-freshness-order-${now}`,
      keywords: ["海外金融", "銀行貸款", "信用卡"],
      excludeShown: true,
      searchMode: "normal",
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["recent-lower-heat", "older-higher-heat"]);
  });

  it("does not accept unrelated travel content from a weak fragment of a real-estate query", () => {
    const candidates = finalizeSentimentHotCandidatesForDisplay([{
      id: "japan-travel-only",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@travel/post/japan-travel-only",
      author: "travel",
      content: "日本自由行最近很多人讨论东京樱花季、大阪环球影城、京都赏枫路线和北海道温泉。这里整理交通票券、饭店选择、行李寄送、机场接送与热门餐厅预约经验，方便第一次去日本旅行的人规划完整行程。",
      media: [],
      hotScore: 9000,
      metrics: { query: "比较", modelQuery: true, archiveScopedFallback: true },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    }] as any, 10, {
      keywords: ["日本不动产", "日本房产", "东京豪宅"],
      excludeShown: true,
      searchMode: "normal",
    });

    expect(candidates).toEqual([]);
  });

  it("does not let a standalone generic search intent become persona relevance", () => {
    const candidates = finalizeSentimentHotCandidatesForDisplay([{
      id: "generic-comparison-only",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@daily/post/generic-comparison-only",
      author: "daily",
      content: "今天整理家里的旧照片和通讯录，比较不同年份的生活变化，也记录朋友分享的工作经验与个人选择。整篇内容都在讨论日常回忆、家庭收纳、亲友往来和心情变化，主题完全属于普通生活随笔。",
      media: [],
      hotScore: 9000,
      metrics: { query: "比较", modelQuery: true },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    }] as any, 10, {
      keywords: ["汽车维修", "汽车保养", "客车底盘"],
      excludeShown: true,
      searchMode: "normal",
    });

    expect(candidates).toEqual([]);
  });

  it("does not accept an ambiguous single keyword in normal mode", () => {
    const candidate = {
      id: "jingxin-school",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@news/post/jingxin-school",
      author: "news",
      content: "这篇人物资料介绍某位政治人物早年就读静心国民中学，之后进入高中与大学，并整理历年求学经历、选举过程和公开活动纪录。全文主题是教育背景与政治生涯，不是健康练习内容。",
      media: [],
      hotScore: 9000,
      metrics: { source: "threads-account-search", query: "静心" },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    } as const;

    expect(candidateMatchesCurrentKeywords(candidate as any, ["静心", "冥想", "身心灵疗愈"], "normal")).toBe(false);
  });

  it("does not accept a single broad strategy term as normal persona relevance", () => {
    const candidate = {
      id: "generic-guide",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic-guide",
      author: "demo",
      content: "\u8fd9\u662f\u4e00\u7bc7\u666e\u901a\u6e38\u620f\u653b\u7565\uff0c\u8be6\u7ec6\u4ecb\u7ecd\u89d2\u8272\u5347\u7ea7\u3001\u5730\u56fe\u63a2\u7d22\u3001\u88c5\u5907\u642d\u914d\u548c\u5267\u60c5\u4efb\u52a1\uff0c\u5168\u6587\u90fd\u662f\u865a\u62df\u4e16\u754c\u73a9\u6cd5\u5206\u6790\u3002",
      media: [],
      hotScore: 9000,
      metrics: {},
    } as any;
    const strategy = {
      primaryQueries: ["\u5ba0\u7269"],
      broadQueries: ["\u653b\u7565"],
      ecosystemQueries: ["\u751f\u6d3b"],
      requiredAnchorTerms: ["\u5ba0\u7269\u7528\u54c1"],
      normalAnchorTerms: ["\u5ba0\u7269"],
      rejectTerms: [],
      strictAcceptTerms: ["\u5ba0\u7269\u7528\u54c1"],
      normalAcceptTerms: ["\u653b\u7565", "\u751f\u6d3b"],
      personaGuardTerms: ["\u5ba0\u7269"],
      domainSummary: "\u5ba0\u7269\u7528\u54c1",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "normal")).toBe(false);
  });

  it("does not accept a parent-domain anchor alone in strict mode", () => {
    const candidate = {
      id: "generic-art",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic-art",
      author: "demo",
      content: "\u5f53\u4ee3\u827a\u672f\u5c55\u89c8\u5206\u4eab\uff0c\u8ba8\u8bba\u6cb9\u753b\u3001\u96d5\u5851\u3001\u88c5\u7f6e\u4e0e\u7a7a\u95f4\u8bbe\u8ba1\uff0c\u5e76\u6574\u7406\u7b56\u5c55\u4eba\u7684\u516c\u5f00\u8bb2\u5ea7\u548c\u89c2\u5c55\u8def\u7ebf\u3002",
      media: [],
      hotScore: 9000,
      metrics: {},
    } as any;
    const strategy = {
      primaryQueries: ["\u523a\u9752"],
      broadQueries: ["\u827a\u672f"],
      ecosystemQueries: ["\u6f6e\u6d41"],
      requiredAnchorTerms: ["\u523a\u9752", "\u7eb9\u8eab"],
      normalAnchorTerms: ["\u827a\u672f"],
      rejectTerms: [],
      strictAcceptTerms: ["\u523a\u9752", "\u7eb9\u8eab"],
      normalAcceptTerms: ["\u827a\u672f", "\u6f6e\u6d41"],
      personaGuardTerms: ["\u523a\u9752"],
      domainSummary: "\u523a\u9752\u7eb9\u8eab",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(false);
  });

  it("does not let a persona role name bypass strict domain anchors", () => {
    const candidate = {
      id: "generic-secretary-story",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic-secretary-story",
      author: "demo",
      content: "\u8fd9\u7bc7\u6587\u7ae0\u53ea\u662f\u56de\u987e\u4e00\u4f4d\u79d8\u4e66\u4ece\u5165\u804c\u5230\u5347\u4efb\u4e3b\u4efb\u7684\u804c\u573a\u7ecf\u5386\uff0c\u5305\u542b\u65e5\u7a0b\u5b89\u6392\u3001\u4f1a\u8bae\u7eaa\u8981\u3001\u6587\u4ef6\u5f52\u6863\u3001\u5ba2\u6237\u63a5\u5f85\u548c\u56e2\u961f\u6c9f\u901a\uff0c\u6574\u7bc7\u5185\u5bb9\u90fd\u662f\u884c\u653f\u5de5\u4f5c\u4e0e\u4e2a\u4eba\u6210\u957f\u6545\u4e8b\u3002",
      media: [],
      hotScore: 9000,
      metrics: { query: "\u79d8\u4e66" },
    } as any;
    const strategy = {
      primaryQueries: ["\u80a1\u7968\u6295\u8d44"],
      broadQueries: ["\u91d1\u878d\u5e02\u573a"],
      ecosystemQueries: ["\u7406\u8d22\u65b0\u624b"],
      requiredAnchorTerms: ["\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAnchorTerms: ["\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      rejectTerms: [],
      strictAcceptTerms: ["\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAcceptTerms: ["\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      personaGuardTerms: ["\u79d8\u4e66"],
      domainSummary: "\u91d1\u878d\u7406\u8d22\u4e0e\u6295\u8d44\u8d37\u6b3e\u89c4\u5212",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(false);
  });

  it("preserves explicit secondary domains for a composite niche persona", () => {
    const strategy = {
      primaryQueries: ["\u52a8\u6f2b\u65b0\u756a"],
      broadQueries: ["\u5b85\u6587\u5316"],
      ecosystemQueries: ["\u4e8c\u6b21\u5143"],
      requiredAnchorTerms: ["\u52a8\u6f2b", "\u4e8c\u6b21\u5143"],
      normalAnchorTerms: ["\u52a8\u6f2b\u6587\u5316"],
      rejectTerms: [],
      strictAcceptTerms: ["\u52a8\u6f2b", "\u4e8c\u6b21\u5143"],
      normalAcceptTerms: ["\u52a8\u6f2b\u6587\u5316"],
      domainSummary: "\u52a8\u6f2b\u548c\u4e8c\u6b21\u5143",
    } as any;

    applyPersonaGuardToSentimentHotStrategy({
      strategy,
      archiveName: "\u89d2\u8272\u626e\u6f14\u4eba\u8bbe",
      personaSeedKeywords: ["\u89d2\u8272\u626e\u6f14", "\u523a\u9752", "\u7535\u7ade", "\u8db3\u7403", "\u6295\u8d44\u7406\u8d22"],
      sourceText: "\u559c\u6b22 Cosplay \u548c\u523a\u9752\uff0c\u5173\u6ce8\u7535\u7ade\u6e38\u620f\u3001\u8db3\u7403\u8d5b\u4e8b\u4e0e\u6295\u8d44\u7406\u8d22\u3002",
    });

    expect(strategy.requiredAnchorTerms).toEqual(expect.arrayContaining([
      "\u523a\u9752Coser",
      "\u7535\u7ade\u6e38\u620f",
      "\u8db3\u7403\u8d5b\u4e8b",
      "\u6295\u8d44\u7406\u8d22",
    ]));
    expect(strategy.primaryQueries).toEqual(expect.arrayContaining([
      "\u523a\u9752Coser",
      "\u7535\u7ade\u6e38\u620f",
      "\u8db3\u7403\u8d5b\u4e8b",
      "\u6295\u8d44\u7406\u8d22",
    ]));
  });

  it("does not let a persona role name bypass normal domain anchors", () => {
    const candidate = {
      id: "generic-secretary-normal-story",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic-secretary-normal-story",
      author: "demo",
      content: "\u8fd9\u7bc7\u6587\u7ae0\u53ea\u662f\u56de\u987e\u4e00\u4f4d\u79d8\u4e66\u4ece\u5165\u804c\u5230\u5347\u4efb\u4e3b\u4efb\u7684\u804c\u573a\u7ecf\u5386\uff0c\u5305\u542b\u65e5\u7a0b\u5b89\u6392\u3001\u4f1a\u8bae\u7eaa\u8981\u3001\u6587\u4ef6\u5f52\u6863\u3001\u5ba2\u6237\u63a5\u5f85\u548c\u56e2\u961f\u6c9f\u901a\uff0c\u6574\u7bc7\u5185\u5bb9\u90fd\u662f\u884c\u653f\u5de5\u4f5c\u4e0e\u4e2a\u4eba\u6210\u957f\u6545\u4e8b\u3002",
      media: [],
      hotScore: 9000,
      metrics: { query: "\u79d8\u4e66" },
    } as any;
    const strategy = {
      primaryQueries: ["\u80a1\u7968\u6295\u8d44"],
      broadQueries: ["\u91d1\u878d\u5e02\u573a"],
      ecosystemQueries: ["\u7406\u8d22\u65b0\u624b"],
      requiredAnchorTerms: ["\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAnchorTerms: ["\u79d8\u4e66", "\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      rejectTerms: [],
      strictAcceptTerms: ["\u79d8\u4e66", "\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAcceptTerms: ["\u79d8\u4e66", "\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      personaGuardTerms: ["\u79d8\u4e66"],
      domainSummary: "\u91d1\u878d\u7406\u8d22\u4e0e\u6295\u8d44\u8d37\u6b3e\u89c4\u5212",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "normal")).toBe(false);
  });

  it("accepts a direct parent-domain anchor in normal mode", () => {
    const candidate = {
      id: "fresh-bank-analysis",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@finance/post/fresh-bank-analysis",
      author: "finance",
      content: "\u4eca\u5929\u6574\u7406\u94f6\u884c\u623f\u8d37\u5229\u7387\u3001\u8fd8\u6b3e\u671f\u9650\u548c\u4fe1\u7528\u8bc4\u5206\u7684\u5f71\u54cd\uff0c\u6bd4\u8f83\u4e0d\u540c\u8d37\u6b3e\u65b9\u6848\u7684\u603b\u6210\u672c\u3001\u63d0\u524d\u8fd8\u6b3e\u6761\u4ef6\u548c\u8d44\u91d1\u8c03\u5ea6\u98ce\u9669\uff0c\u63d0\u9192\u7533\u8bf7\u4eba\u6839\u636e\u5b9e\u9645\u73b0\u91d1\u6d41\u505a\u51b3\u5b9a\u3002",
      media: [],
      hotScore: 12000,
      metrics: { query: "\u94f6\u884c" },
    } as any;
    const strategy = {
      primaryQueries: ["\u80a1\u7968\u6295\u8d44"],
      broadQueries: ["\u91d1\u878d\u5e02\u573a"],
      ecosystemQueries: ["\u7406\u8d22\u65b0\u624b"],
      requiredAnchorTerms: ["\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAnchorTerms: ["\u79d8\u4e66", "\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      rejectTerms: [],
      strictAcceptTerms: ["\u79d8\u4e66", "\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAcceptTerms: ["\u79d8\u4e66", "\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      personaGuardTerms: ["\u79d8\u4e66"],
      domainSummary: "\u91d1\u878d\u7406\u8d22\u4e0e\u6295\u8d44\u8d37\u6b3e\u89c4\u5212",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "normal")).toBe(true);
  });

  it("accepts one direct domain anchor in strict mode", () => {
    const candidate = {
      id: "fresh-stock-analysis",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@finance/post/fresh-stock-analysis",
      author: "finance",
      content: "\u4eca\u5929\u6574\u7406\u80a1\u7968\u5e02\u573a\u7684\u91cf\u4ef7\u53d8\u5316\u4e0e\u98ce\u9669\u63a7\u5236\u601d\u8def\uff0c\u8ba8\u8bba\u516c\u53f8\u57fa\u672c\u9762\u3001\u73b0\u91d1\u6d41\u3001\u4f30\u503c\u533a\u95f4\u548c\u4ed3\u4f4d\u7ba1\u7406\uff0c\u63d0\u9192\u6295\u8d44\u4eba\u4e0d\u8981\u56e0\u4e3a\u77ed\u671f\u6ce2\u52a8\u76f2\u76ee\u8ffd\u9ad8\u6740\u4f4e\u3002",
      media: [],
      hotScore: 12000,
      metrics: { query: "\u80a1\u7968" },
    } as any;
    const strategy = {
      primaryQueries: ["\u80a1\u7968\u6295\u8d44"],
      broadQueries: ["\u91d1\u878d\u5e02\u573a"],
      ecosystemQueries: ["\u7406\u8d22\u65b0\u624b"],
      requiredAnchorTerms: ["\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAnchorTerms: ["\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      rejectTerms: [],
      strictAcceptTerms: ["\u80a1\u7968", "\u8d37\u6b3e", "\u7406\u8d22", "\u878d\u8d44"],
      normalAcceptTerms: ["\u91d1\u878d", "\u8bc1\u5238", "\u94f6\u884c"],
      personaGuardTerms: ["\u79d8\u4e66"],
      domainSummary: "\u91d1\u878d\u7406\u8d22\u4e0e\u6295\u8d44\u8d37\u6b3e\u89c4\u5212",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(true);
  });

  it("does not display hot candidates shorter than 60 Chinese characters", () => {
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "short-hot",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@demo/post/short",
        author: "demo",
        content: "海外信貸最近討論很多，信用卡和銀行貸款都很熱門。",
        media: [],
        hotScore: 90000,
        metrics: {},
        capturedAt: new Date().toISOString(),
      },
      {
        id: "long-hot",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@demo/post/long",
        author: "demo",
        content: "海外信貸最近討論很多，信用卡和銀行貸款都很熱門。有人整理收入證明、負債比、利率審核、還款節奏和現金流安排，提醒工薪族不要只看額度，也要確認長期風險。這種長文更適合改寫成人設乾貨。",
        media: [],
        hotScore: 80000,
        metrics: {},
        capturedAt: new Date().toISOString(),
      },
    ] as any, 10);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["long-hot"]);
  });

  it("keeps heat ordering in final candidates", () => {
    const base = {
      platform: "threads",
      author: "demo",
      capturedAt: new Date().toISOString(),
      media: [],
      metrics: {},
    } as const;
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        ...base,
        id: "hot-without-qa",
        sourceUrl: "https://www.threads.net/@demo/post/hot-without-qa",
        content: "海外信貸市場最近很多人在討論信用卡週轉和銀行貸款審核，這篇熱度很高，但還沒有模型 old-marker 標記。內容同時提到收入證明、負債比和還款壓力，足以作為長文候選排序測試，也能檢查熱度排序是否優先。",
        hotScore: 50000,
      },
      {
        ...base,
        id: "qa-lower-heat",
        sourceUrl: "https://www.threads.net/@demo/post/qa-lower-heat",
        content: "海外工薪族最近討論貸款利率和信用卡債務整合，有人整理收入證明、負債比、還款節奏和銀行審核條件，適合改寫成務實提醒。這條候選已通過 old-marker，但熱度低於另一條，用來確認 old-marker 標記不會壓過高熱度。",
        hotScore: 9000,
      },
    ] as any, 10);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["hot-without-qa", "qa-lower-heat"]);
  });

  it("deduplicates final hot candidates by original post id and media urls", () => {
    const base = {
      platform: "threads",
      author: "demo",
      capturedAt: new Date().toISOString(),
      metrics: {},
    } as const;
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        ...base,
        id: "same-post-low",
        sourceUrl: "https://www.threads.net/@demo/post/POST123?utm_source=a",
        content: "海外金融信貸案例最近很多人討論，有人整理信用卡額度、貸款利率、銀行審核和現金流安排，提醒工薪族不要只看能不能借到錢，也要看還款風險。這條用來測試相同原帖低熱度版本會被合併。",
        media: [],
        hotScore: 9000,
      },
      {
        ...base,
        id: "same-post-high",
        sourceUrl: "https://www.threads.net/@demo/post/POST123?x=1",
        content: "同一篇原帖被不同查詢通道抓到，內容描述稍微不同，但 post id 一樣，應該只保留熱度更高的版本。這裡補充信用卡額度、銀行審核、信貸利率和還款規劃，確保候選長度符合硬門檻，也確認去重不受文字差異干擾。",
        media: [],
        hotScore: 20000,
      },
      {
        ...base,
        id: "same-media-low",
        sourceUrl: "https://www.threads.net/@demo/post/media-low",
        content: "海外信貸與信用卡週轉的討論很多，這篇帶同一張媒體圖，應該被後面的高熱度媒體重複項合併。",
        media: [{ type: "image", url: "https://cdn.example.com/a.jpg?utm_source=low" }],
        hotScore: 8000,
      },
      {
        ...base,
        id: "same-media-high",
        sourceUrl: "https://www.threads.net/@demo/post/media-high",
        content: "同一個媒體文件被另一個入口抓到，文字不完全相同，但媒體 URL 一樣，保留高熱度版本。這條也提到海外信貸、信用卡週轉、銀行貸款審核和現金流安排，避免被短文規則排除，同時驗證媒體 URL 去重是否穩定。",
        media: [{ type: "image", url: "https://cdn.example.com/a.jpg?utm_source=high" }],
        hotScore: 18000,
      },
      {
        ...base,
        id: "unique",
        sourceUrl: "https://www.threads.net/@demo/post/unique",
        content: "海外工薪族最近也在討論銀行貸款審核，這是一條不同原帖不同媒體的有效候選，應該正常保留。內容補充信用卡、利率、收入證明和負債比，滿足長文候選要求，也確認唯一候選不被錯誤合併或短文規則誤刪。",
        media: [{ type: "image", url: "https://cdn.example.com/unique.jpg" }],
        hotScore: 7000,
      },
    ] as any, 10);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["same-post-high", "same-media-high", "unique"]);
  });

  it("matches finance hot candidates through clean search keyword variants", () => {
    const candidate = {
      id: "finance-candidate",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/finance",
      author: "demo",
      media: [],
      hotScore: 12000,
      metrics: {},
      capturedAt: new Date().toISOString(),
      content: "最近很多海外华人工薪族都在讨论银行贷款和信用卡债务，贷款利率变高以后，现金流规划比盲目消费更重要。",
    };

    expect(candidateMatchesCurrentKeywords(candidate as any, [
      "海外金融",
      "工薪信貸",
      "理財規劃",
      "銀行審核",
    ])).toBe(true);
    expect(candidateMatchesCurrentKeywords(candidate as any, [
      "說話直白犀利",
      "接地氣幽默",
    ])).toBe(false);

    expect(candidateMatchesCurrentKeywords({
      ...candidate,
      content: "最近房贷利率和债务整合讨论很多，信用评分不好的人申请贷款前真的要先整理现金流。",
    } as any, [
      "海外信貸",
      "理財規劃",
    ])).toBe(true);
  });

  it("keeps engagement signals from Threads reader candidates", () => {
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "醫療",
      keywords: ["醫療", "醫生", "醫院"],
      sourceUrl: "https://www.threads.net/search?q=%E9%86%AB%E7%99%82",
      text: `
Search • Threads

[Demo Doctor](https://www.threads.net/@demo_doctor)
[01/02/2026](https://www.threads.net/@demo_doctor/post/abc123)
醫生分享醫療現場，今天醫院急診真的塞滿人，病人等待和醫療流程都被拿出來討論。
1.2萬
340
88
`,
    });

    expect(candidates.length).toBe(1);
    expect(candidates[0].metrics.raw_engagement_signals).toEqual([12000, 340, 88]);
    expect(candidates[0].engagement?.rawSignals).toEqual([12000, 340, 88]);
  });

  it("parses Threads reader links returned over plain http", () => {
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "汽車維修",
      keywords: ["汽車維修"],
      sourceUrl: "https://www.threads.com/search?q=%E6%B1%BD%E8%BB%8A%E7%B6%AD%E4%BF%AE",
      text: `
Search Threads

[Demo](http://www.threads.com/@demo)
[01/02/2026](http://www.threads.com/@demo/post/http123)
汽車維修保養與煞車安全是車主近期最關心的實用議題，這篇內容整理常見故障與檢查方式。
`,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceUrl).toBe("http://www.threads.com/@demo/post/http123");
  });

  it("parses relative Threads reader dates for strict freshness filtering", () => {
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "tea",
      keywords: ["tea"],
      sourceUrl: "https://www.threads.com/search?q=tea",
      text: `
Search Threads

[Demo](https://www.threads.com/@demo)
[2d](https://www.threads.com/@demo/post/relative123)
tea\u8336\u6587\u5316\u65e5\u5e38\u5206\u4eab\u8207\u6162\u751f\u6d3b\u9ad4\u9a57\u7684\u5be6\u7528\u5efa\u8b70\u8207\u5fc3\u5f97\u3002
`,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].publishedAt).toBeDefined();
    expect(Date.now() - Date.parse(candidates[0].publishedAt || "")).toBeLessThan(3 * 24 * 60 * 60 * 1000);
  });

  it("parses Threads account-search GraphQL posts with real engagement totals", () => {
    const candidates = parseThreadsGraphqlSearchPayload({
      freshnessFallbackAt: "2026-07-17T09:00:00.000Z",
      query: "醫療",
      keywords: ["醫療", "醫生", "醫院"],
      payload: {
        data: {
          searchResults: {
            edges: [{
              node: {
                thread_items: [{
                  post: {
                    pk: "3925594288747063183",
                    code: "DZ1ABCxyz",
                    canonical_url: "https://www.threads.com/@demo_doctor/post/DZ1ABCxyz",
                    user: { username: "demo_doctor" },
                    caption: {
                      text: "急診醫生分享醫療現場，今天醫院候診區真的塞滿人，病人等待和醫療流程都被拿出來討論。",
                    },
                    image_versions2: {
                      candidates: [{
                        url: "https://scontent.example.com/v/t51.82787-19/profile.jpg",
                      }],
                    },
                    like_count: 954,
                    text_post_app_info: {
                      direct_reply_count: 68,
                      repost_count: 92,
                      reshare_count: 58,
                      view_count: 4321,
                    },
                  },
                }],
              },
            }],
          },
        },
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].media).toEqual([]);
    expect(candidates[0].publishedAt).toBe("2026-07-17T09:00:00.000Z");
    expect(candidates[0]).toMatchObject({
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo_doctor/post/DZ1ABCxyz",
      author: "demo_doctor",
      content: "急診醫生分享醫療現場，今天醫院候診區真的塞滿人，病人等待和醫療流程都被拿出來討論。",
      hotScore: 1172,
      metrics: {
        source: "threads-account-search",
        like_count: 954,
        comment_count: 68,
        repost_count: 92,
        reshare_count: 58,
        share_count: 58,
        view_count: 4321,
        realEngagementTotal: 1172,
      },
      engagement: {
        likeCount: 954,
        commentCount: 68,
        shareCount: 58,
        viewCount: 4321,
        rawSignals: [954, 68, 92, 58],
      },
    });
  });

  it("reads the next-page cursor from Threads search GraphQL payloads", () => {
    expect(parseThreadsGraphqlSearchPageInfo({
      data: {
        searchResults: {
          page_info: {
            end_cursor: "cursor-page-2",
            has_next_page: true,
          },
        },
      },
    })).toEqual({ endCursor: "cursor-page-2", hasNextPage: true });
  });

  it("enriches final Threads.com candidates with real views from post details", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => `
Title: Demo on Threads

## [Thread 186K views](https://www.threads.com/@demo/post/real-views)

Demo post body

19.5K

51

3.3K

1.7K
`,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const [candidate] = await enrichThreadsCandidateDetails([{
      id: "real-views",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo/post/real-views",
      author: "demo",
      content: "这是一条用于验证真实浏览量详情补全的热点推文。",
      media: [],
      hotScore: 24_551,
      metrics: {
        source: "threads-account-search",
        like_count: 19_500,
        comment_count: 51,
        repost_count: 3_300,
        reshare_count: 1_700,
      },
      engagement: {
        likeCount: 19_500,
        commentCount: 51,
        shareCount: 1_700,
      },
      capturedAt: new Date().toISOString(),
    }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(candidate.engagement?.viewCount).toBe(186_000);
    expect(candidate.metrics).toMatchObject({ view_count: 186_000 });
    expect(candidate.hotScore).toBe(186_000);
  });

  it("forces a fresh detail read when a cached candidate already has views", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "## [Thread 99 views](https://www.threads.com/@demo/post/refresh-views)",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const [candidate] = await enrichThreadsCandidateDetails([{
      id: "refresh-views",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo/post/refresh-views",
      author: "demo",
      content: "刷新时应覆盖已经缓存的旧浏览量。",
      media: [],
      hotScore: 100,
      metrics: { view_count: 100 },
      engagement: { viewCount: 100 },
      capturedAt: new Date().toISOString(),
    }], { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(candidate.engagement?.viewCount).toBe(99);
    expect(candidate.metrics).toMatchObject({ view_count: 99 });
  });

  it("keeps the 1000 display threshold for every source", () => {
    const base = {
      platform: "threads",
      author: "demo",
      media: [],
      capturedAt: new Date().toISOString(),
    } as const;
    const content = "醫療現場最近持續討論急診候診、醫院分流、醫生排班和病人照護流程，這篇完整整理第一線工作壓力、資源配置、溝通方式與改善建議，提供醫療人員和一般讀者理解現況。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        ...base,
        id: "account-accepted",
        sourceUrl: "https://www.threads.net/@demo/post/account-accepted",
        content,
        hotScore: 1000,
        metrics: { source: "threads-account-search" },
      },
      ...["threads-account-search", "threads-reader-search", "threads-search-page"].map((source, index) => ({
        ...base,
        id: `below-threshold-${index}`,
        sourceUrl: `https://www.threads.net/@demo/post/below-threshold-${index}`,
        content: `${content} 候選來源編號${index + 1}。`,
        hotScore: 999,
        metrics: { source },
      })),
    ] as any, 10, { keywords: ["醫療", "醫生", "醫院"] });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["account-accepted"]);
  });

  it("parses Instagram reader candidates as extra sentiment sources", () => {
    const candidates = parseInstagramReaderSearchMarkdownCandidates({
      query: "醫療",
      keywords: ["醫療", "醫生", "醫院"],
      sourceUrl: "https://www.instagram.com/explore/search/keyword/?q=%E9%86%AB%E7%99%82",
      text: `
Title: Instagram

[Demo Doctor](https://www.instagram.com/demo_doctor/)
[View post](https://www.instagram.com/p/abc123/)
急診醫生分享醫療現場，今天醫院等候區真的塞滿人，病人等待和醫療流程都被拿出來討論。
1.1K likes
82 comments
![Image 1](https://cdn.example.com/ig-a.jpg)
`,
    });

    expect(candidates.length).toBe(1);
    expect(candidates[0].platform).toBe("instagram");
    expect(candidates[0].sourceUrl).toBe("https://www.instagram.com/p/abc123/");
    expect(candidates[0].engagement?.likeCount).toBe(1100);
    expect(candidates[0].engagement?.commentCount).toBe(82);
    expect(candidates[0].media.map((item) => item.url)).toEqual(["https://cdn.example.com/ig-a.jpg"]);
  });

  it("parses Threads detail metrics from reader markdown", () => {
    const engagement = parseThreadsDetailEngagementMarkdown(`
Title: Demo on Threads

# [Thread 978K views](https://www.threads.net/@demo/post/abc)

Demo post body

31.9K

355

713

5.6K
`);

    expect(engagement.viewCount).toBe(978000);
    expect(engagement.likeCount).toBe(31900);
    expect(engagement.commentCount).toBeUndefined();
    expect(engagement.shareCount).toBeUndefined();
    expect(engagement.rawSignals).toEqual([31900, 355, 713, 5600]);
  });

  it("does not treat unlabeled Threads detail numbers as comments or reposts", () => {
    const engagement = parseThreadsDetailEngagementMarkdown(`
Title: Demo on Threads

# [Thread 269 views](https://www.threads.net/@demo/post/abc)

Demo post body

2

291

88

6
`);

    expect(engagement.viewCount).toBe(269);
    expect(engagement.likeCount).toBe(2);
    expect(engagement.commentCount).toBeUndefined();
    expect(engagement.shareCount).toBeUndefined();
    expect(engagement.rawSignals).toEqual([2, 291, 88, 6]);
  });

  it("matches old published Threads posts from the logged-in profile page", () => {
    const text = `
stevie875443
1天
2 足球運動與金融投資理財
翻譯
291
54
88
13
stevie875443
1天
你心目中一生必看的 動漫 神作？
翻譯
209
56
1
13
`;
    const links = [
      "https://www.threads.com/@stevie875443/post/DZ6zcSaErFb",
      "https://www.threads.com/@stevie875443/post/DZ6gGNAEqjT",
    ];

    const posts = parseThreadsBrowserProfilePublishedPosts({ username: "stevie875443", text, links });
    expect(posts.map((post) => post.sourceUrl)).toEqual([
      "https://www.threads.net/@stevie875443/post/DZ6zcSaErFb",
      "https://www.threads.net/@stevie875443/post/DZ6gGNAEqjT",
    ]);

    const matched = matchThreadsBrowserProfilePublishedPost({
      username: "stevie875443",
      text,
      links,
      content: "你心目中一生必看的 動漫 神作？",
    });
    expect(matched?.sourceUrl).toBe("https://www.threads.net/@stevie875443/post/DZ6gGNAEqjT");
    expect(matched?.engagement).toMatchObject({
      likeCount: 209,
      commentCount: 56,
      shareCount: 1,
      rawSignals: [209, 56, 1, 13],
    });
    expect(matched?.metrics).toMatchObject({
      like_count: 209,
      comment_count: 56,
      share_count: 1,
      send_count: 13,
    });
  });

  it("uses labeled Threads post detail buttons instead of guessing unlabeled numbers", () => {
    const detail = parseThreadsBrowserPostDetailMetrics({
      text: `
Log in
Thread
274 views
stevie875443
1d
2 足球運動與金融投資理財
Translate
2
`,
      actionTexts: ["Like", "Comment2", "Repost", "Share"],
    });

    expect(detail?.engagement).toMatchObject({
      likeCount: 0,
      commentCount: 2,
      shareCount: 0,
    });
    expect(detail?.metrics).toMatchObject({
      like_count: 0,
      comment_count: 2,
      share_count: 0,
      repost_count: 0,
      send_count: 0,
      view_count: 274,
    });
    expect(detail?.hotScore).toBe(274);
  });

  it("keeps a real Threads view count even when action buttons are not readable", () => {
    const detail = parseThreadsBrowserPostDetailMetrics({
      text: "Thread 186K views\nDemo post body",
      actionTexts: [],
    });

    expect(detail).toEqual({
      hotScore: 186_000,
      engagement: { viewCount: 186_000 },
      metrics: { view_count: 186_000 },
    });
  });

  it("overwrites existing named metrics when refreshing a stored Threads source", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => `
Title: Demo on Threads

# [Thread 250 views](https://www.threads.net/@demo/post/abc)

Demo post body

20

5

3

88
`,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshSentimentSourceMetrics({
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/abc",
      existingHotScore: 100,
      existingEngagement: {
        viewCount: 100,
        likeCount: 10,
        commentCount: 1,
        shareCount: 1,
        rawSignals: [100, 10, 1],
      },
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(refreshed.ok, JSON.stringify(refreshed)).toBe(true);
    expect(refreshed.engagement?.viewCount).toBe(250);
    expect(refreshed.engagement?.likeCount).toBe(20);
    expect(refreshed.engagement?.commentCount).toBeUndefined();
    expect(refreshed.engagement?.shareCount).toBeUndefined();
    expect(refreshed.metrics).toMatchObject({
      view_count: 250,
      like_count: 20,
      comment_count: 0,
      share_count: 0,
      repost_count: 0,
      send_count: 0,
    });
    expect(refreshed.hotScore).toBe(250);
  });

  it("keeps only top-level media files from Threads detail markdown", () => {
    const media = parseThreadsDetailMediaMarkdown(`
![Image 1: demo profile picture](https://cdn.example.com/profile_pic.jpg)
![Image 2](https://cdn.example.com/a.jpg)
![Image 3](https://cdn.example.com/b.webp)
![Image 4](https://cdn.example.com/c.jpg)
[![Image 5: reply_user's profile picture](https://cdn.example.com/reply-s150x150.jpg)](https://www.threads.net/@reply)
![Image 6](https://cdn.example.com/reply-body.jpg)
Log in to see more replies.
`);

    expect(media.map((item) => item.url)).toEqual([
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/b.webp",
      "https://cdn.example.com/c.jpg",
    ]);
  });

  it("drops Threads link preview media from detail markdown", () => {
    const media = parseThreadsDetailMediaMarkdown(`
![Image 1](https://scontent-sea5-1.cdninstagram.com/v/t51.82787-15/post.jpg)
![Image 2](https://external-sea5-1.xx.fbcdn.net/emg1/v/t13/preview?url=https%3A%2F%2Fexample.com%2Fcover.jpg)
![Image 3](https://www.youtube.com/s/desktop/favicon_144x144.png)
`);

    expect(media.map((item) => item.url)).toEqual([
      "https://scontent-sea5-1.cdninstagram.com/v/t51.82787-15/post.jpg",
    ]);
  });

  it("creates stable candidate ids from platform, url, and content", () => {
    const first = buildSentimentCandidateId({
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/1",
      content: "demo content",
    });
    const second = buildSentimentCandidateId({
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/1",
      content: "demo content",
    });
    const other = buildSentimentCandidateId({
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/p/demo",
      content: "demo content",
    });

    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it("cleans social search breadcrumbs from candidate content", () => {
    const cleaned = cleanSentimentCandidateContent(
      "www.threads.net › t › CuiVm72yO3g Threads ... Threads palantir vulnerability canonical site:threads.net 相關 廣告 www.ups.com/Luxury_Goods/Shipping",
    );

    expect(cleaned).not.toContain("www.threads.net");
    expect(cleaned).not.toContain("›");
    expect(cleaned).not.toContain("廣告");
    expect(cleaned).not.toContain("site:threads.net");
    expect(cleaned).not.toContain("CuiVm72yO3g");
    expect(cleaned).toContain("palantir vulnerability canonical");
  });

  it("keeps only Chinese sentiment copy candidates", () => {
    expect(isChineseSentimentCandidate("公路車的世界裡有兩種人是最強的，邊騎邊自拍的人真的很厲害。")).toBe(true);
    expect(isChineseSentimentCandidate("palantir vulnerability 原文")).toBe(false);
    expect(isChineseSentimentCandidate("gpt 爆料")).toBe(false);
  });

  it("parses Traditional Chinese Threads search page text as fallback candidates", () => {
    const candidates = parseThreadsSearchTextCandidates({
      query: "醫療",
      keywords: ["醫療", "醫生", "醫院"],
      sourceUrl: "https://www.threads.com/search?q=%E9%86%AB%E7%99%82",
      sourceUrls: [
        "https://www.threads.net/@mls_muttering/post/medical-report",
        "https://www.threads.net/@bunundoc/post/emergency-room",
      ],
      text: `
醫療
mls_muttering
醫療化驗
2天
[93]
有冇人知醫療化驗報告要等幾耐，最近身體狀況有點奇怪，想知道診所流程係點。
翻譯
4
5
bunundoc
2026-3-2
我走到病人床邊。你好，我是急診醫師，今天醫院真的塞滿人，醫療現場比想像中更混亂。
翻譯
3.5 萬
330
`,
    });

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].platform).toBe("threads");
    expect(candidates[0].content).toContain("醫療");
    expect(candidates[0].content).not.toContain("翻譯");
    expect(candidates[0].sourceUrl).toBe("https://www.threads.net/@mls_muttering/post/medical-report");
  });

  it("keeps rendered reaction counts when Threads UI labels and relative age are present", () => {
    const candidates = parseThreadsSearchTextCandidates({
      query: "\u623f\u8cb8",
      keywords: ["\u623f\u8cb8"],
      sourceUrl: "https://www.threads.com/search?q=house-loan",
      text: [
        "@demo",
        "\u623f\u8cb8",
        "1d",
        "\u9019\u662f\u4e00\u6bb5\u5305\u542b\u623f\u8cb8\u548c\u9280\u884c\u8cc7\u8a0a\u7684\u4e2d\u6587\u5167\u5bb9\u8d85\u904e\u5341\u516b\u500b\u6f22\u5b57",
        "Translate",
        "27",
        "40",
        "9",
      ].join("\n"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].author).toBe("demo");
    expect(candidates[0].hotScore).toBe(76);
    expect(candidates[0].engagement?.rawSignals).toEqual([27, 40, 9]);
  });

  it("keeps visible Threads profile metrics from the page body", () => {
    const visible = analyzeThreadsProfileVisibleSignals({
      username: "stevie875443",
      bodyText: `
阿牛投資理財|挑戰10年財務自由
4 位粉絲
12 追蹤中
6.1 萬次最近瀏覽次數
      `,
      buttonText: ["追蹤", "分享"],
      links: [],
    });

    expect(visible.parsed.followers).toBe(4);
    expect(visible.parsed.following).toBe(12);
    expect(visible.parsed.recentViews).toBe(61000);
    expect(visible.hasUsableProfileSignals).toBe(true);
  });

  it("does not double-count duplicated Threads profile recent views", () => {
    const visible = analyzeThreadsProfileVisibleSignals({
      username: "stevie875443",
      bodyText: `
阿牛投資理財|挑戰10年財務自由
4 位粉絲
6.1 萬次最近瀏覽次數
Instagram
4位粉絲
6.1 萬次最近瀏覽次數
      `,
      buttonText: [],
      links: [],
    });

    expect(visible.parsed.recentViews).toBe(61000);
    expect(visible.parsed.views).toBeUndefined();
  });

  it("parses paginated Threads profile GraphQL payload into real post metrics", () => {
    const parsed = parseThreadsGraphqlProfilePagePayload({
      username: "stevie875443",
      payload: {
        data: {
          mediaData: {
            edges: [
              {
                node: {
                  thread_items: [{
                    post: {
                      pk: "3925594288747063183",
                      code: "DZ1ABCxyz",
                      canonical_url: "https://www.threads.com/@stevie875443/post/DZ1ABCxyz",
                      taken_at: 1782075045,
                      like_count: 954,
                      text_post_app_info: {
                        direct_reply_count: 68,
                        repost_count: 92,
                        reshare_count: 58,
                      },
                    },
                  }],
                },
              },
            ],
            page_info: {
              end_cursor: "cursor-1",
              has_next_page: true,
            },
          },
        },
      },
    });

    expect(parsed.posts).toEqual([{
      pk: "3925594288747063183",
      code: "DZ1ABCxyz",
      sourceUrl: "https://www.threads.com/@stevie875443/post/DZ1ABCxyz",
      publishedAt: "2026-06-21T20:50:45.000Z",
      likeCount: 954,
      commentCount: 68,
      repostCount: 92,
      shareCount: 58,
    }]);
    expect(parsed.endCursor).toBe("cursor-1");
    expect(parsed.hasNextPage).toBe(true);
  });

  it("skips Threads GraphQL profile posts owned by another author", () => {
    const parsed = parseThreadsGraphqlProfilePagePayload({
      username: "stevie875443",
      payload: {
        data: {
          mediaData: {
            edges: [
              {
                node: {
                  thread_items: [{
                    post: {
                      pk: "foreign-post",
                      code: "DaKf3wEkuYz",
                      canonical_url: "https://www.threads.com/@stevie875443/post/DaKf3wEkuYz",
                      user: { username: "shaopon" },
                      like_count: 200000,
                      text_post_app_info: {
                        direct_reply_count: 2386,
                        repost_count: 4954,
                        reshare_count: 49000,
                      },
                    },
                  }],
                },
              },
            ],
            page_info: {
              end_cursor: "",
              has_next_page: false,
            },
          },
        },
      },
    });

    expect(parsed.posts).toEqual([]);
    expect(parsed.hasNextPage).toBe(false);
  });

  it("normalizes relative Threads profile post times for fresh posts", () => {
    const now = Date.UTC(2026, 5, 29, 16, 0, 0);

    expect(normalizeThreadsRelativeTime("2小時", now)).toBe("2026-06-29T14:00:00.000Z");
    expect(normalizeThreadsRelativeTime("1天", now)).toBe("2026-06-28T16:00:00.000Z");
    expect(normalizeThreadsRelativeTime("15h", now)).toBe("2026-06-29T01:00:00.000Z");
  });

  it("parses Threads post view counts directly from the detail page text", () => {
    expect(parseThreadsPostViewCountFromText(`
串文
84次瀏覽
stevie875443
2天
超好笑到底誰寫的www
    `)).toBe(84);

    expect(parseThreadsPostViewCountFromText(`
Thread
6.1萬 views
    `)).toBe(61000);
  });

  it("does not treat a visible Threads profile as a login wall just because login CTA text is present", () => {
    const links = [
      "https://www.threads.com/@stevie875443/post/DZ6zcSaErFb",
      "https://www.threads.com/@stevie875443/post/DZ6gGNAEqjT",
    ];

    expect(shouldTreatThreadsProfileAsLoginWall({
      username: "stevie875443",
      bodyText: `
阿牛投資理財|挑戰10年財務自由
4 位粉絲
12 追蹤中
6.1 萬次最近瀏覽次數
登入以查看更多
      `,
      buttonText: ["Sign in", "追蹤"],
      links,
    })).toBe(false);
  });

  it("still treats a Threads login prompt without profile signals as a login wall", () => {
    expect(shouldTreatThreadsProfileAsLoginWall({
      username: "stevie875443",
      bodyText: "登入以查看更多",
      buttonText: ["Sign in", "使用 Instagram 帳號繼續"],
      links: [],
    })).toBe(true);
  });
});
