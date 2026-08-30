import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  acquireSentimentBrowserWorkSlot,
  anonymousReaderRetryReason,
  applyPersonaGuardToSentimentHotStrategy,
  boundedBrowserPageConcurrency,
  buildInstagramProfileHttpMetrics,
  buildPlatformCookieHeader,
  buildInstagramHotSearchQueries,
  buildModelOrderedThreadsSearchQueries,
  buildSentimentHotSearchStrategyCacheKey,
  buildThreadsReaderSearchUrl,
  buildThreadsReaderSearchTargets,
  buildThreadsSearchDateWindow,
  buildThreadsSearchUrl,
  candidateMatchesRequestedFreshness,
  candidateMatchesSentimentHotStrategyAnchors,
  candidateMatchesCurrentKeywords,
  cleanSentimentCandidateContent,
  enrichThreadsCandidateDetails,
  ensureSentimentHotPlatformContributions,
  finalizeSentimentHotCandidatesForDisplay,
  normalizeRequestedHotPlatform,
  resolveHotLiveFetchTargets,
  isObviouslyLowQualitySentimentHotCandidate,
  isCacheableSentimentReaderResponse,
  isRetryableAnonymousReaderError,
  isChineseSentimentCandidate,
  isUsableThreadsSearchGraphqlTemplate,
  parseInstagramAuthenticatedSearchPayload,
  parseInstagramProfileHotMetricsPayload,
  parseInstagramReaderSearchMarkdownCandidates,
  matchThreadsBrowserProfilePublishedPost,
  parseThreadsBrowserPostDetailMetrics,
  parseThreadsBrowserProfilePublishedPosts,
  parseThreadsGraphqlSearchPayload,
  parseThreadsSearchHydrationPayloads,
  parseThreadsSearchCardCandidates,
  parseThreadsGraphqlSearchPageInfo,
  parseThreadsGraphqlProfilePagePayload,
  normalizeThreadsRelativeTime,
  normalizeSentimentHotFreshnessDays,
  normalizeSentimentHotFreshnessPolicy,
  normalizeSentimentBrowserCookieExpiry,
  orderSentimentHotCandidatesForLegacyFallback,
  isSentimentHotCandidateRepeatEligible,
  parseThreadsPostViewCountFromText,
  parseThreadsPostViewCountFromHtml,
  extractThreadsAuthenticatedViewerUsername,
  parseThreadsReaderSearchMarkdownCandidates,
  persistSentimentReaderMarkdown,
  resolveSentimentHotCandidateOrigin,
  formatPublicThreadsReaderMarkdown,
  readerMarkdownLooksEmpty,
  readerBodyLooksLikeLoginWall,
  threadsHtmlLooksLikeEmptySearch,
  extractThreadsSearchPrefetchPayload,
  extractThreadsHydrationCandidatesFromHtml,
  extractThreadsProfileHttpPayloads,
  extractThreadsProfileUserId,
  extractThreadsProfileUserStats,
  buildSpiderSearchMarkdownFromHotCandidates,
  parseThreadsDetailEngagementMarkdown,
  parseThreadsDetailMediaMarkdown,
  mergeCandidateMedia,
  personaHotStrategyDisplayName,
  parseThreadsSearchTextCandidates,
  refreshSentimentSourceMetrics,
  replaceThreadsSearchVariables,
  resolveSentimentHotModelStrategyKeywords,
  resolveSentimentHotModelQueryKeywords,
  resolveSentimentHotManualQueryKeywords,
  resolveSentimentHotStrategyTimeoutMs,
  resolveSentimentHotDisplayHeatThreshold,
  resolveSentimentHotReaderConcurrency,
  resolveSentimentHotReaderTotalTimeoutMs,
  resolveAnonymousReaderJitterMaxMs,
  resolveAnonymousReaderJitterMs,
  resolveAnonymousReaderMaxAttempts,
  shouldRunSentimentHotReaderPlatformsSerially,
  SENTIMENT_HOT_READER_CONCURRENCY,
  resolveSentimentHotTextModelPreference,
  shouldTreatThreadsProfileAsLoginWall,
  shouldUseThreadsSearchGraphqlTemplate,
} from "@/lib/sentiment-hot-importer";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sentiment hot importer", () => {
  it("uses one fixed 24-request public Reader window", () => {
    expect(SENTIMENT_HOT_READER_CONCURRENCY).toBe(24);
  });

  it("resolves isolated interactive and refill Reader profiles", () => {
    expect(resolveSentimentHotReaderConcurrency(undefined)).toBe(24);
    expect(resolveSentimentHotReaderConcurrency("4")).toBe(4);
    expect(resolveSentimentHotReaderConcurrency("99")).toBe(24);
    expect(resolveSentimentHotReaderTotalTimeoutMs("55000")).toBe(55_000);
    expect(resolveSentimentHotReaderTotalTimeoutMs("28000")).toBe(28_000);
    expect(resolveSentimentHotReaderTotalTimeoutMs("999999")).toBe(90_000);
    expect(resolveAnonymousReaderJitterMaxMs("200")).toBe(200);
    expect(resolveAnonymousReaderJitterMaxMs("999999")).toBe(5_000);
    expect(resolveAnonymousReaderMaxAttempts("1")).toBe(1);
    expect(resolveAnonymousReaderMaxAttempts("9")).toBe(2);
    expect(shouldRunSentimentHotReaderPlatformsSerially("1")).toBe(true);
    expect(shouldRunSentimentHotReaderPlatformsSerially("0")).toBe(false);
  });

  it("keeps interactive Reader jitter under 200ms so keyword searches start together", () => {
    vi.stubEnv("SENTIMENT_HOT_READER_JITTER_MAX_MS", "200");
    expect(resolveAnonymousReaderJitterMs(0)).toBe(0);
    expect(resolveAnonymousReaderJitterMs(0.999999)).toBe(200);
  });

  it("retries only transient Reader failures that can benefit from a new proxy connection", () => {
    expect(anonymousReaderRetryReason({ ok: false, status: 429, headers: {}, body: "" })).toBe("rate_limited");
    expect(anonymousReaderRetryReason({ ok: false, status: 503, headers: {}, body: "service unavailable" })).toBe("upstream_503");
    expect(anonymousReaderRetryReason({ ok: true, status: 200, headers: {}, body: "Log in for more Threads" })).toBe("login_wall_or_challenge");
    expect(anonymousReaderRetryReason({ ok: false, status: 404, headers: {}, body: "not found" })).toBe("");
    expect(isRetryableAnonymousReaderError(new Error("request timed out"))).toBe(true);
    expect(isRetryableAnonymousReaderError(new Error("invalid proxy configuration"))).toBe(false);
  });
  it("follows the configured runtime model order for hot keywords", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiment-hot-config-"));
    const configPath = path.join(dir, "api_config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      llmFreeModelPriorityOrder: "google/gemini-3.1-pro-preview, xai/grok-4.3, xai/grok-4.5",
    }));
    vi.stubEnv("AUTO_TWEET_API_CONFIG_PATH", configPath);

    expect(resolveSentimentHotTextModelPreference().split(",").map((model) => model.trim()).slice(0, 3)).toEqual([
      "google/gemini-3.1-pro-preview",
      "xai/grok-4.3",
      "xai/grok-4.5",
    ]);
  });

  it("normalizes millisecond cookie expiry before Playwright uses it", () => {
    expect(normalizeSentimentBrowserCookieExpiry(1_825_453_191_068)).toBeCloseTo(1_825_453_191.068, 3);
    expect(normalizeSentimentBrowserCookieExpiry(1_893_456_000)).toBe(1_893_456_000);
    expect(normalizeSentimentBrowserCookieExpiry(undefined)).toBe(-1);
  });

  it("caps browser detail pages at the shared server limit of two", () => {
    expect(boundedBrowserPageConcurrency(1)).toBe(1);
    expect(boundedBrowserPageConcurrency(2)).toBe(2);
    expect(boundedBrowserPageConcurrency(8)).toBe(2);
  });

  it("caps browser processes inside one hot workflow lease at two slots", async () => {
    const releaseFirst = await acquireSentimentBrowserWorkSlot();
    const releaseSecond = await acquireSentimentBrowserWorkSlot();
    let thirdAcquired = false;
    const third = acquireSentimentBrowserWorkSlot().then((release) => {
      thirdAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    releaseFirst();
    const releaseThird = await third;
    expect(thirdAcquired).toBe(true);
    releaseSecond();
    releaseThird();
  });

  it("keeps collector account searches on the verified DOM path instead of stale GraphQL templates", () => {
    expect(shouldUseThreadsSearchGraphqlTemplate({
      publicOnly: false,
      authenticated: true,
      collectorProfileRequired: true,
    })).toBe(false);
    expect(shouldUseThreadsSearchGraphqlTemplate({
      publicOnly: false,
      authenticated: true,
      collectorProfileRequired: false,
    })).toBe(true);
  });

  it("queues browser processes when server limit is configured as one", async () => {
    const previous = process.env.SENTIMENT_BROWSER_PAGE_CONCURRENCY;
    process.env.SENTIMENT_BROWSER_PAGE_CONCURRENCY = "1";
    const releaseFirst = await acquireSentimentBrowserWorkSlot();
    let secondAcquired = false;
    const second = acquireSentimentBrowserWorkSlot().then((release) => {
      secondAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
    if (previous === undefined) delete process.env.SENTIMENT_BROWSER_PAGE_CONCURRENCY;
    else process.env.SENTIMENT_BROWSER_PAGE_CONCURRENCY = previous;
  });

  it("keeps the Threads reader on the public result page unless recent mode is explicit", () => {
    expect(buildThreadsReaderSearchUrl("理发")).toBe(
      "https://www.threads.com/search?q=%E7%90%86%E5%8F%91",
    );
    expect(buildThreadsReaderSearchUrl("理发", true)).toContain("filter=recent");
  });

  it("does not cache a Threads Reader login-only page", () => {
    expect(isCacheableSentimentReaderResponse({
      ok: true,
      status: 200,
      headers: {},
      body: "Title: Search • Threads\n\nLog in for more threads about this topic.",
    })).toBe(false);
    expect(isCacheableSentimentReaderResponse({
      ok: true,
      status: 200,
      headers: {},
      body: "Title: Search • Threads\n\n[author](http://www.threads.com/@author/post/abc)\n真实热点正文\n1.2K\n88",
    })).toBe(true);
  });

  it("uses Threads recent search only for freshness-scoped fetches", () => {
    expect(buildThreadsSearchUrl("tea")).toBe("https://www.threads.com/search?q=tea");
    expect(buildThreadsSearchUrl("茶文化", true)).toBe(
      "https://www.threads.com/search?q=%E8%8C%B6%E6%96%87%E5%8C%96&filter=recent",
    );
  });

  it("builds two Spider public search rankings and does not emit a hosted Reader URL", () => {
    expect(buildThreadsReaderSearchUrl("女性力量")).toBe("https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E5%8A%9B%E9%87%8F");
    expect(buildThreadsSearchUrl("女性力量", false, "tags")).toBe(
      "https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E5%8A%9B%E9%87%8F&serp_type=tags",
    );
    const targets = buildThreadsReaderSearchTargets("女性力量");
    expect(targets.map((item) => item.ranking)).toEqual(["spider-default", "spider-ranked"]);
    expect(targets.every((item) => item.targetUrl.startsWith("https://www.threads.com/search?"))).toBe(true);
    expect(targets.some((item) => /jina/i.test(item.targetUrl))).toBe(false);
    expect(targets[0].targetUrl).toBe("https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E5%8A%9B%E9%87%8F");
    expect(targets[1].targetUrl).toBe("https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E5%8A%9B%E9%87%8F&serp_type=default");
  });

  it("adds a dated ranked Threads branch without changing the original two URLs", () => {
    const now = new Date("2026-08-20T16:02:33.000Z");
    expect(buildThreadsSearchDateWindow(0, now)).toBeUndefined();
    expect(buildThreadsSearchDateWindow(19, now)).toEqual({
      afterDate: "2026-08-01",
      beforeDate: "2026-08-20",
    });
    const undated = buildThreadsReaderSearchTargets("台股");
    expect(undated.map((item) => item.ranking)).toEqual(["spider-default", "spider-ranked"]);
    const dated = buildThreadsReaderSearchTargets("台股", false, 19, now);
    expect(dated.map((item) => item.ranking)).toEqual(["spider-default", "spider-ranked", "spider-dated"]);
    expect(dated[0].targetUrl).toBe(undated[0].targetUrl);
    expect(dated[1].targetUrl).toBe(undated[1].targetUrl);
    expect(dated[2].targetUrl).toBe(
      "https://www.threads.com/search?after_date=2026-08-01&before_date=2026-08-20&q=%E5%8F%B0%E8%82%A1&serp_type=default",
    );
    expect(dated[2].targetUrl).toContain("serp_type=default");
    expect(dated.some((item) => /jina/i.test(item.targetUrl))).toBe(false);
  });

  it("distinguishes live Spider rows from pool and cache backfill", () => {
    expect(resolveSentimentHotCandidateOrigin({
      id: "live",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@a/post/abc",
      content: "正文",
      hotScore: 600,
      metrics: { origin: "live_spider", liveFetch: true, crawler: "spider-http-hydration", publicSearch: true },
      capturedAt: new Date().toISOString(),
      warnings: [],
    } as any)).toBe("live_spider");
    expect(resolveSentimentHotCandidateOrigin({
      id: "pool",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@a/post/def",
      content: "正文",
      hotScore: 600,
      metrics: { archiveScopedFallback: true, origin: "candidate_pool" },
      capturedAt: new Date().toISOString(),
      warnings: [],
    } as any)).toBe("candidate_pool");
    expect(resolveSentimentHotCandidateOrigin({
      id: "cache",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@a/post/ghi",
      content: "正文",
      hotScore: 600,
      metrics: { origin: "search_cache", liveFetch: false },
      capturedAt: new Date().toISOString(),
      warnings: [],
    } as any)).toBe("search_cache");
  });

  it("forces a persisted Threads GraphQL template into recent mode for freshness-scoped searches", () => {
    expect(replaceThreadsSearchVariables({
      query: "旧词",
      after: "cursor",
      first: 10,
      recent: 0,
      nested: { searchQuery: "旧词" },
    }, "理发师", null, true, 25)).toEqual({
      query: "理发师",
      after: null,
      first: 25,
      recent: 1,
      nested: { searchQuery: "理发师" },
    });
  });

  it("recognizes newer Threads GraphQL search variable names", () => {
    expect(isUsableThreadsSearchGraphqlTemplate({
      endpoint: "/graphql/query",
      method: "POST",
      params: { fb_api_req_friendly_name: "BarcelonaSearchComposerQuery" },
      variables: { input: { search_text: "\u526a\u53d1", pagination: { first: 10 } } },
      headers: {},
    })).toBe(true);

    expect(replaceThreadsSearchVariables({
      input: {
        search_text: "\u526a\u53d1",
        searchTerm: "\u526a\u53d1",
        text: "\u526a\u53d1",
      },
    }, "\u7406\u53d1\u5e97")).toEqual({
      input: {
        search_text: "\u7406\u53d1\u5e97",
        searchTerm: "\u7406\u53d1\u5e97",
        text: "\u7406\u53d1\u5e97",
      },
    });
  });

  it("rejects non-search Threads GraphQL templates even when they contain the searched tag", () => {
    expect(isUsableThreadsSearchGraphqlTemplate({
      endpoint: "/graphql/query",
      method: "POST",
      params: { fb_api_req_friendly_name: "BarcelonaCommunityEntityCardsPanelQuery" },
      variables: { tag_name: "理发" },
      headers: {},
      sourceTerms: ["理发"],
    })).toBe(false);

    expect(isUsableThreadsSearchGraphqlTemplate({
      endpoint: "/graphql/query",
      method: "POST",
      params: { fb_api_req_friendly_name: "BarcelonaSearchResultsQuery" },
      variables: { query: "理发" },
      headers: {},
    })).toBe(true);
  });

  it("allows Threads account post search but rejects keyword suggestion GraphQL templates", () => {
    expect(isUsableThreadsSearchGraphqlTemplate({
      endpoint: "/graphql/query",
      method: "POST",
      params: { fb_api_req_friendly_name: "useBarcelonaAccountSearchGraphQLDataSourceQuery" },
      variables: {
        query: "barber",
        first: 10,
        should_fetch_friendship_status: true,
      },
      headers: {},
      sourceTerms: ["barber"],
    })).toBe(true);

    expect(isUsableThreadsSearchGraphqlTemplate({
      endpoint: "/graphql/query",
      method: "POST",
      params: { fb_api_req_friendly_name: "useBarcelonaKeywordSearchGraphQLDataSourceQuery" },
      variables: {
        query: "barber",
        has_communities: true,
        has_favicons: true,
      },
      headers: {},
      sourceTerms: ["barber"],
    })).toBe(false);
  });

  it("reuses a persona search strategy when only volatile memory summaries change", () => {
    const base = {
      archive: {
        id: "hairdresser",
        name: "理发师",
        content: "分享理发行业见闻",
        setup: { genres: ["美发"] },
      } as any,
      personaText: "人设名称：理发师",
    };
    expect(buildSentimentHotSearchStrategyCacheKey({
      ...base,
      memorySummaries: ["今天聊短发"],
    })).toBe(buildSentimentHotSearchStrategyCacheKey({
      ...base,
      memorySummaries: ["昨天聊染发", "新的临时记忆"],
    }));
  });

  it("does not send slang nicknames like 老司机 to the keyword model", () => {
    expect(personaHotStrategyDisplayName("理发师")).toBe("理发师");
    expect(personaHotStrategyDisplayName("老司机")).toBe("按下方职业与内容领域理解的人设");
    expect(personaHotStrategyDisplayName("老司機")).toBe("按下方职业与内容领域理解的人设");
  });

  it("separates hot-keyword strategy caches by configured platform tag keywords", () => {
    const base = {
      archive: {
        id: "persona-tag-keywords",
        name: "beauty creator",
        content: "beauty routines",
        setup: { genres: ["beauty"], trendTopics: ["skincare routine"] },
      } as any,
      prompt: "",
      personaText: "persona: beauty creator",
    };

    expect(buildSentimentHotSearchStrategyCacheKey(base))
      .not.toBe(buildSentimentHotSearchStrategyCacheKey({
        ...base,
        archive: { ...base.archive, setup: { ...base.archive.setup, trendTopics: ["makeup review"] } },
      }));
  });

  it("separates hot-keyword strategy caches by requested writing locale", () => {
    const base = {
      archive: { id: "persona-1", name: "hairdresser", content: "hair and beauty" },
      prompt: "",
      personaText: "persona: hairdresser",
    };

    expect(buildSentimentHotSearchStrategyCacheKey({ ...base, writingLocale: "zh-CN" }))
      .not.toBe(buildSentimentHotSearchStrategyCacheKey({ ...base, writingLocale: "zh-TW" }));
  });

  it("ignores free-form user supplements in hot-keyword strategy cache identity", () => {
    const base = {
      archive: { id: "persona-1", name: "hairdresser", content: "hair and beauty" },
      personaText: "persona: hairdresser",
      writingLocale: "zh-CN",
    };

    expect(buildSentimentHotSearchStrategyCacheKey({ ...base, prompt: "临时追一个明星话题" }))
      .toBe(buildSentimentHotSearchStrategyCacheKey({ ...base, prompt: "另一个临时要求" }));
  });

  it("keeps model search phrases intact instead of spending queries on generic fragments", () => {
    const queries = buildModelOrderedThreadsSearchQueries([
      "理发师 手工 改造",
      "美发沙龙 职场 趣事",
    ]);
    expect(queries).toContain("理发师 手工 改造");
    expect(queries).toContain("美发沙龙 职场 趣事");
    expect(queries).not.toContain("手工");
    expect(queries).not.toContain("改造");
    expect(queries).not.toContain("职场");
    expect(queries).not.toContain("趣事");
  });

  it("keeps model primary query order and excludes generic anchor filler from strict dispatch", () => {
    const strategy = {
      primaryQueries: ["\u6c7d\u8f66\u4fee\u7406\u7ffb\u8f66", "\u4fee\u8f66\u907f\u5751", "\u53d1\u52a8\u673a\u7ef4\u4fee\u4ef7\u683c", "\u4fee\u8f66\u524d\u540e\u5bf9\u6bd4", "\u6c7d\u8f66\u4fee\u7406\u7ecf\u9a8c"],
      ecosystemQueries: ["\u6c7d\u8f66\u7ef4\u4fee\u884c\u4e1a"],
      broadQueries: ["\u6c7d\u8f66\u7ef4\u4fee\u4e89\u8bae"],
      requiredAnchorTerms: ["\u6c7d\u8f66\u4fee\u7406", "\u4fee\u8f66", "\u53d1\u52a8\u673a\u7ef4\u4fee"],
      normalAnchorTerms: ["\u6c7d\u8f66", "\u7ef4\u4fee", "\u53d1\u52a8\u673a"],
      strictAcceptTerms: ["\u95ee\u9898", "\u7cfb\u7edf", "\u771f\u5b9e", "\u7ef4\u4fee", "\u6c7d\u8f66"],
      normalAcceptTerms: ["\u95ee\u9898", "\u7cfb\u7edf", "\u771f\u5b9e", "\u7ef4\u4fee", "\u6c7d\u8f66"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "\u6c7d\u8f66\u7ef4\u4fee\u884c\u4e1a",
    } as any;

    const keywords = resolveSentimentHotModelStrategyKeywords(strategy, "strict");
    expect(keywords[0]).toBe("\u6c7d\u8f66\u4fee\u7406\u7ffb\u8f66");
    expect(keywords).toEqual(expect.arrayContaining(strategy.primaryQueries));
    expect(keywords).not.toContain("\u95ee\u9898");
    expect(keywords).not.toContain("\u7cfb\u7edf");
    expect(keywords).not.toContain("\u771f\u5b9e");

    const queries = buildModelOrderedThreadsSearchQueries(["\u53d8\u901f\u7bb1\u95ee\u9898", "\u6c7d\u8f66\u4fee\u7406\u771f\u5b9e", "\u5239\u8f66\u7cfb\u7edf"]);
    expect(queries).toContain("\u53d8\u901f\u7bb1\u95ee\u9898");
    expect(queries).not.toContain("\u95ee\u9898");
    expect(queries).not.toContain("\u7cfb\u7edf");
    expect(queries).not.toContain("\u771f\u5b9e");
    expect(queries).not.toContain("\u7ef4\u4fee");
  });

  it("uses broad vertical model terms for strict discovery without widening strict acceptance", () => {
    const strategy = {
      primaryQueries: ["理发师 顾客 吐槽", "理发店 奇葩客人", "剪头发 翻车", "男士理发 油头", "美发沙龙 职场"],
      ecosystemQueries: [],
      broadQueries: ["染发烫发价格踩雷"],
      requiredAnchorTerms: ["理发师", "美发师", "发型师"],
      normalAnchorTerms: ["美发造型", "美发沙龙", "发型设计"],
      strictAcceptTerms: ["发型师", "理发店", "剪头发", "美发师", "理发师"],
      normalAcceptTerms: ["护发", "染发", "烫发", "发型设计", "美发造型"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "理发与美发行业",
    } as any;
    expect(resolveSentimentHotModelStrategyKeywords(strategy, "strict")).not.toContain("染发烫发价格踩雷");
    expect(resolveSentimentHotModelQueryKeywords(strategy, "strict")).toContain("染发烫发价格踩雷");
  });

  it("appends short domain-expansion objects after primary queries", () => {
    const strategy = {
      primaryQueries: ["台股", "融資", "存股", "配息", "當沖", "槓桿", "股票", "貸款", "鋼琴", "琴譜", "資產", "信用交易"],
      ecosystemQueries: [],
      broadQueries: ["除權息", "融資券", "台股分享", "融資攻略", "染发烫发价格踩雷"],
      requiredAnchorTerms: ["台股", "融資", "存股"],
      normalAnchorTerms: ["理財", "投資", "鋼琴"],
      strictAcceptTerms: ["台股", "融資", "存股", "配息", "當沖"],
      normalAcceptTerms: ["台股", "融資", "存股", "配息", "當沖"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "台股融資與鋼琴教學",
    } as any;
    const keywords = resolveSentimentHotModelStrategyKeywords(strategy, "strict");
    expect(keywords.slice(0, 12)).toEqual(strategy.primaryQueries);
    expect(keywords).toEqual(expect.arrayContaining(["除權息", "融資券"]));
    expect(keywords).not.toContain("台股分享");
    expect(keywords).not.toContain("融資攻略");
    expect(keywords).not.toContain("染发烫发价格踩雷");
  });

  it("keeps more specific object nouns that only share a short prefix", () => {
    const keywords = resolveSentimentHotManualQueryKeywords([
      "融資",
      "融資券",
      "配息",
      "融資攻略",
      "台股分享",
    ], null, "strict");
    expect(keywords).toEqual(expect.arrayContaining(["融資", "融資券", "配息"]));
    expect(keywords).not.toContain("融資攻略");
    expect(keywords).not.toContain("台股分享");
  });

  it("derives core search terms from model generated concrete keywords", () => {
    const strategy = {
      primaryQueries: ["\u7406\u53d1\u5e97", "\u526a\u5934\u53d1", "\u70eb\u53d1", "\u67d3\u53d1", "\u53d1\u578b"],
      ecosystemQueries: ["\u7406\u53d1\u5e97\u4e92\u52a8", "\u7406\u53d1\u771f\u5b9e\u4f53\u9a8c", "\u526a\u53d1\u4ef7\u683c"],
      broadQueries: ["\u7406\u53d1\u907f\u5751", "\u53d1\u578b\u670d\u52a1", "\u7406\u53d1\u6d4b\u8bc4"],
      requiredAnchorTerms: ["\u7406\u53d1\u5e97", "\u53d1\u578b\u5e08", "\u526a\u5934\u53d1"],
      normalAnchorTerms: ["\u7406\u53d1\u5e97", "\u53d1\u578b\u5e08", "\u7f8e\u53d1\u5e97"],
      strictAcceptTerms: ["\u7406\u53d1\u5e97", "\u526a\u5934\u53d1", "\u53d1\u578b\u5e08", "\u53d1\u578b\u670d\u52a1", "\u7406\u53d1\u907f\u5751"],
      normalAcceptTerms: ["\u7406\u53d1\u5e97", "\u526a\u5934\u53d1", "\u53d1\u578b\u5e08", "\u7406\u53d1\u771f\u5b9e\u4f53\u9a8c", "\u53d1\u578b\u670d\u52a1"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "\u7406\u53d1\u4e0e\u7f8e\u53d1\u884c\u4e1a",
    } as any;

    const acceptanceKeywords = resolveSentimentHotModelStrategyKeywords(strategy, "strict");
    const queryKeywords = resolveSentimentHotModelQueryKeywords(strategy, "strict");

    expect(acceptanceKeywords).toEqual(expect.arrayContaining(["剪头发", "烫发", "染发", "发型"]));
    expect(queryKeywords.length).toBeGreaterThanOrEqual(5);
  });

  it("matches strategy anchors through derived model core terms", () => {
    const strategy = {
      primaryQueries: ["\u7406\u53d1\u5e97", "\u526a\u5934\u53d1", "\u53d1\u578b\u5e08", "\u70eb\u53d1", "\u67d3\u53d1"],
      ecosystemQueries: ["\u7406\u53d1\u5e97\u4e92\u52a8", "\u7406\u53d1\u771f\u5b9e\u4f53\u9a8c", "\u526a\u53d1\u4ef7\u683c"],
      broadQueries: ["\u7406\u53d1\u907f\u5751", "\u53d1\u578b\u670d\u52a1", "\u7406\u53d1\u6d4b\u8bc4"],
      requiredAnchorTerms: ["\u7406\u53d1\u5e97", "\u53d1\u578b\u5e08", "\u526a\u5934\u53d1"],
      normalAnchorTerms: ["\u7406\u53d1\u5e97", "\u53d1\u578b\u5e08", "\u7f8e\u53d1\u5e97"],
      strictAcceptTerms: ["\u7406\u53d1\u5e97", "\u526a\u5934\u53d1", "\u53d1\u578b\u5e08", "\u53d1\u578b\u670d\u52a1", "\u7406\u53d1\u907f\u5751"],
      normalAcceptTerms: ["\u7406\u53d1\u5e97", "\u526a\u5934\u53d1", "\u53d1\u578b\u5e08", "\u7406\u53d1\u771f\u5b9e\u4f53\u9a8c", "\u53d1\u578b\u670d\u52a1"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "\u7406\u53d1\u4e0e\u7f8e\u53d1\u884c\u4e1a",
    } as any;
    const candidate = {
      id: "instagram-core-haircut",
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/p/core/",
      author: "salon",
      content: "\u8fd9\u4f4d\u8d44\u6df1\u53d1\u578b\u5e08\u5206\u4eab\u7406\u53d1\u540e\u7684\u62a4\u7406\u6280\u5de7\uff0c\u9488\u5bf9\u6f6e\u6e7f\u5929\u6c14\u4e0b\u5934\u53d1\u6bdb\u8e81\u548c\u53d1\u5c3e\u5e72\u67af\u95ee\u9898\u7ed9\u51fa\u5177\u4f53\u5efa\u8bae\u3002",
      hotScore: 1600,
      metrics: { source: "instagram-account-search", query: "\u7406\u53d1" },
      engagement: { likeCount: 1500, commentCount: 100, rawSignals: [1500, 100] },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
      warnings: [],
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(true);
  });

  it("adds script variants only from model generated hot query terms", () => {
    const keywords = [
      "\u7406\u9aee\u907f\u5751",
      "\u7406\u9aee\u5e97\u63a8\u85a6",
      "\u526a\u9aee\u670d\u52d9",
    ];
    const queries = buildModelOrderedThreadsSearchQueries(keywords);
    const instagramQueries = buildInstagramHotSearchQueries(keywords, keywords);

    expect(queries).toContain("\u7406\u9aee\u907f\u5751");
    expect(queries).toContain("\u7406\u53d1\u907f\u5751");
    expect(queries).toContain("\u7406\u53d1\u5e97\u63a8\u8350");
    expect(queries).toContain("\u526a\u53d1\u670d\u52a1");
    expect(queries).not.toContain("\u6309\u6469\u6280\u5e08");
    expect(instagramQueries).toContain("\u7406\u53d1\u907f\u5751");
    expect(instagramQueries).toContain("\u7406\u53d1\u5e97\u63a8\u8350");
    expect(instagramQueries).not.toContain("\u6309\u6469\u6280\u5e08");
  });

  it("keeps script variants inside the first browser query window", () => {
    const queries = buildModelOrderedThreadsSearchQueries([
      "\u7406\u9aee\u907f\u5751",
      "\u7406\u9aee\u5e97\u63a8\u85a6",
      "\u526a\u9aee\u670d\u52d9",
      "\u7406\u9aee\u524d\u5f8c",
      "\u9867\u5ba2\u4e92\u52d5",
      "\u7406\u9aee\u50f9\u683c",
      "\u9aee\u578b\u8a2d\u8a08",
      "\u7406\u9aee\u771f\u5be6\u9ad4\u9a57",
      "\u7406\u9aee\u6e2c\u8a55",
      "\u7406\u9aee\u5834\u666f",
      "\u526a\u9aee\u75db\u9ede",
      "\u7406\u9aee\u4e92\u52d5",
    ]);
    const firstBrowserWindow = queries.slice(0, 24);

    expect(firstBrowserWindow).toContain("\u7406\u53d1\u907f\u5751");
    expect(firstBrowserWindow).toContain("\u7406\u53d1\u5e97\u63a8\u8350");
    expect(firstBrowserWindow).toContain("\u526a\u53d1\u670d\u52a1");
  });

  it("matches simplified candidate text against traditional strategy anchors in strict mode", () => {
    const strategy = {
      primaryQueries: ["\u7406\u9aee\u907f\u5751", "\u7406\u9aee\u5e97\u63a8\u85a6", "\u526a\u9aee\u670d\u52d9"],
      ecosystemQueries: ["\u7406\u9aee\u771f\u5be6\u9ad4\u9a57"],
      broadQueries: ["\u9aee\u578b\u8a2d\u8a08"],
      requiredAnchorTerms: ["\u7406\u9aee\u5e97", "\u526a\u9aee", "\u9aee\u578b\u5e2b"],
      normalAnchorTerms: ["\u7f8e\u9aee\u5e97", "\u9aee\u578b\u8a2d\u8a08"],
      strictAcceptTerms: ["\u7406\u9aee\u5e97", "\u526a\u9aee", "\u7406\u9aee\u907f\u5751"],
      normalAcceptTerms: ["\u7f8e\u9aee", "\u9aee\u578b"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "\u7406\u9aee\u8207\u7f8e\u9aee\u884c\u696d",
    } as any;
    const candidate = {
      id: "simplified-haircut",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@salon/post/simplified-haircut",
      author: "salon",
      content: "\u8fd9\u5bb6\u7406\u53d1\u5e97\u5206\u4eab\u526a\u53d1\u524d\u540e\u5bf9\u6bd4\u548c\u53d1\u578b\u5e08\u6c9f\u901a\u7ecf\u9a8c\uff0c\u63d0\u9192\u987e\u5ba2\u5148\u786e\u8ba4\u53d1\u578b\u9700\u6c42\u3001\u4ef7\u683c\u548c\u5934\u53d1\u62a4\u7406\u65b9\u5f0f\u3002",
      media: [],
      hotScore: 5000,
      metrics: { query: "\u7406\u53d1\u907f\u5751" },
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(true);
  });

  it("still rejects unrelated simplified candidates after script expansion", () => {
    const strategy = {
      primaryQueries: ["\u7406\u9aee\u907f\u5751", "\u7406\u9aee\u5e97\u63a8\u85a6", "\u526a\u9aee\u670d\u52d9"],
      ecosystemQueries: [],
      broadQueries: [],
      requiredAnchorTerms: ["\u7406\u9aee\u5e97", "\u526a\u9aee", "\u9aee\u578b\u5e2b"],
      normalAnchorTerms: ["\u7f8e\u9aee\u5e97", "\u9aee\u578b\u8a2d\u8a08"],
      strictAcceptTerms: ["\u7406\u9aee\u5e97", "\u526a\u9aee", "\u7406\u9aee\u907f\u5751"],
      normalAcceptTerms: ["\u7f8e\u9aee", "\u9aee\u578b"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "\u7406\u9aee\u8207\u7f8e\u9aee\u884c\u696d",
    } as any;
    const candidate = {
      id: "unrelated-massage",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@spa/post/unrelated",
      author: "spa",
      content: "\u4eca\u5929\u8ba8\u8bba\u6309\u6469\u5e97\u670d\u52a1\u548c\u6280\u5e08\u5de5\u4f5c\u6d41\u7a0b\uff0c\u5305\u542b\u9884\u7ea6\u3001\u5ba2\u670d\u3001\u4f1a\u5458\u4ef7\u683c\u548c\u95e8\u5e97\u73af\u5883\u4f53\u9a8c\uff0c\u91cd\u70b9\u662f\u653e\u677e\u9879\u76ee\u548c\u7a7a\u95f4\u5b89\u6392\u3002",
      media: [],
      hotScore: 8000,
      metrics: { query: "\u6309\u6469\u670d\u52a1" },
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(false);
  });

  it("keeps manually edited strict keywords before cached model query terms", () => {
    const strategy = {
      primaryQueries: ["理发店", "剪头发", "发型设计", "剪发", "理发前后"],
      ecosystemQueries: ["男士发型", "短发发型", "刘海翻车", "烫发避坑"],
      broadQueries: ["染发烫发价格踩雷", "换发型前后对比", "发型师吐槽"],
      requiredAnchorTerms: ["理发", "剪发", "发型"],
      normalAnchorTerms: ["美发", "造型", "发型设计"],
      strictAcceptTerms: ["理发店", "剪头发", "剪发", "发型师", "发型设计"],
      normalAcceptTerms: ["染发", "烫发", "刘海", "短发", "男士发型"],
      rejectTerms: [],
      personaGuardTerms: [],
      domainSummary: "理发与美发行业",
    } as any;

    const queries = resolveSentimentHotManualQueryKeywords(["理发店趣事", "顾客互动"], strategy, "strict");

    expect(queries).toEqual(expect.arrayContaining(["男士发型", "剪发", "发型"]));
  });

  it("preserves an explicit high-volume core term as the first normal search query", () => {
    const queries = resolveSentimentHotManualQueryKeywords(
      ["地震", "台湾地震", "防灾"],
      null,
      "normal",
    );

    expect(queries.slice(0, 3)).toEqual(["地震", "台湾地震", "防灾"]);
  });

  it("keeps Instagram search aligned with Threads query keyword order", () => {
    const queries = buildInstagramHotSearchQueries(
      ["\u7406\u53d1", "\u526a\u53d1", "\u53d1\u578b"],
      ["\u7406\u53d1\u907f\u5751", "\u7406\u53d1\u5e97\u4e92\u52a8", "\u7406\u53d1"],
    );

    expect(queries.slice(0, 3)).toEqual(["\u7406\u53d1", "\u526a\u53d1", "\u53d1\u578b"]);
    expect(queries.indexOf("\u7406\u53d1")).toBeLessThan(queries.indexOf("\u7406\u53d1\u907f\u5751"));
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
    const belowHeat = { ...shown, id: "below-heat", hotScore: 499 } as any;
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

  it("gives a live refresh enough time to obtain a model search strategy", () => {
    expect(resolveSentimentHotStrategyTimeoutMs(true, 50_000)).toBe(8_000);
    expect(resolveSentimentHotStrategyTimeoutMs(false, 50_000)).toBe(8_000);
    expect(resolveSentimentHotStrategyTimeoutMs(true, 5_000)).toBe(5_000);
  });

  it("uses the configured runtime model order for hot-topic text models", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiment-hot-config-"));
    const configPath = path.join(dir, "api_config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      llmModelPriorityOrder: "google/gemini-3.1-pro-preview, xai/grok-4.3, xai/grok-4.5",
    }));
    vi.stubEnv("AUTO_TWEET_API_CONFIG_PATH", configPath);
    const models = resolveSentimentHotTextModelPreference().split(",").map((model) => model.trim());
    expect(models.slice(0, 3)).toEqual([
      "google/gemini-3.1-pro-preview",
      "xai/grok-4.3",
      "xai/grok-4.5",
    ]);
  });

  it("never manufactures fallback keywords when the model strategy is unavailable", () => {
    expect(resolveSentimentHotModelStrategyKeywords(null, "strict")).toEqual([]);
    expect(resolveSentimentHotModelStrategyKeywords({
      primaryQueries: [],
      broadQueries: [],
      ecosystemQueries: [],
      requiredAnchorTerms: [],
      normalAnchorTerms: [],
      rejectTerms: [],
      strictAcceptTerms: [],
      normalAcceptTerms: [],
      domainSummary: "",
    } as any, "strict")).toEqual([]);
  });

  it("drops hollow and overlapping persona search keywords", () => {
    const keywords = resolveSentimentHotManualQueryKeywords([
      "菜市場撿漏",
      "菜市場",
      "菜市場買菜",
      "菜市場環保袋",
      "便宜",
      "大叔",
      "煙火氣",
      "二次元",
      "二次元大叔",
      "手辦",
    ], null, "strict");
    expect(keywords).toContain("菜市場");
    expect(keywords).toContain("二次元");
    expect(keywords).toContain("手辦");
    expect(keywords).not.toContain("便宜");
    expect(keywords).not.toContain("大叔");
    expect(keywords).not.toContain("煙火氣");
    expect(keywords).not.toContain("二次元大叔");
    expect(resolveSentimentHotManualQueryKeywords(["菜市場真實體驗", "二次元 吐槽", "撿漏 真實", "理財 對比"], null, "strict")).toEqual([]);
    expect(resolveSentimentHotManualQueryKeywords(["環保袋 菜市場", "二次元 撿漏"], null, "strict")).toEqual([]);
    const mixed = resolveSentimentHotManualQueryKeywords(["二次元", "菜市場", "二次元菜市場", "菜市場蔬菜"], null, "strict");
    expect(mixed).toContain("二次元");
    expect(mixed).toContain("菜市場");
    expect(mixed).not.toContain("二次元菜市場");
  });

  it("uses the same hollow and object-noun rules for unrelated persona domains", () => {
    const finance = resolveSentimentHotManualQueryKeywords([
      "基金定投",
      "指數基金",
      "債券配息",
      "存股清單",
      "便宜",
      "攻略",
      "經驗",
      "理財真實體驗",
    ], null, "strict");
    expect(finance).toContain("基金定投");
    expect(finance).toContain("指數基金");
    expect(finance).not.toContain("便宜");
    expect(finance).not.toContain("攻略");
    expect(finance).not.toContain("經驗");
    expect(finance).not.toContain("理財真實體驗");

    const fitness = resolveSentimentHotManualQueryKeywords([
      "深蹲訓練",
      "硬拉動作",
      "蛋白粉",
      "減脂餐",
      "便宜",
      "大叔",
      "健身 吐槽",
    ], null, "strict");
    expect(fitness).toContain("深蹲訓練");
    expect(fitness).toContain("蛋白粉");
    expect(fitness).not.toContain("便宜");
    expect(fitness).not.toContain("大叔");
    expect(fitness).not.toContain("健身 吐槽");
  });

  it("strips hollow atmosphere anchors so they cannot pin every query", () => {
    const strategy = {
      primaryQueries: ["基金定投", "市井生活", "指數基金"],
      broadQueries: ["指數基金"],
      ecosystemQueries: [],
      requiredAnchorTerms: ["基金", "市井生活"],
      normalAnchorTerms: ["理財", "購物"],
      strictAcceptTerms: ["真實體驗", "基金定投"],
      normalAcceptTerms: ["基金定投"],
      rejectTerms: [],
    } as any;
    applyPersonaGuardToSentimentHotStrategy({ strategy });
    expect(strategy.requiredAnchorTerms).toContain("基金");
    expect(strategy.requiredAnchorTerms).not.toContain("市井生活");
    expect(strategy.normalAnchorTerms).not.toContain("購物");
    expect(strategy.strictAcceptTerms).not.toContain("真實體驗");
    expect(strategy.primaryQueries).not.toContain("市井生活");
  });

  it("keeps persona-domain objects and drops visual or lifestyle fillers", () => {
    const strategy = {
      primaryQueries: ["茶葉", "茶具", "圍裙", "家務", "棉麻衫", "慢生活"],
      broadQueries: ["茶道", "退休生活"],
      ecosystemQueries: [],
      requiredAnchorTerms: ["茶葉", "茶具", "家務"],
      normalAnchorTerms: ["茶道", "慢生活"],
      strictAcceptTerms: ["茶湯", "口哨", "造型"],
      normalAcceptTerms: ["茶席"],
      rejectTerms: [],
    } as any;
    applyPersonaGuardToSentimentHotStrategy({ strategy });
    expect(strategy.primaryQueries).toEqual(expect.arrayContaining(["茶葉", "茶具"]));
    expect(strategy.primaryQueries).not.toContain("圍裙");
    expect(strategy.primaryQueries).not.toContain("家務");
    expect(strategy.primaryQueries).not.toContain("棉麻衫");
    expect(strategy.requiredAnchorTerms).not.toContain("家務");
    expect(strategy.normalAnchorTerms).not.toContain("慢生活");
    expect(strategy.strictAcceptTerms).not.toContain("口哨");
    expect(strategy.strictAcceptTerms).not.toContain("造型");
    const manual = resolveSentimentHotManualQueryKeywords(
      ["剪髮", "造型", "頭髮", "口哨", "家務", "茶葉"],
      null,
      "strict",
    );
    expect(manual).toEqual(expect.arrayContaining(["剪髮", "茶葉"]));
    expect(manual).not.toContain("造型");
    expect(manual).not.toContain("口哨");
    expect(manual).not.toContain("家務");
    expect(manual).not.toContain("頭髮");
  });

  it("keeps model object nouns when a new persona only has visual or lifestyle anchors", () => {
    const strategy = {
      primaryQueries: ["段子", "办公室", "同事", "枸杞茶", "笑话", "加班", "工位", "通勤"],
      broadQueries: ["职场", "段子"],
      ecosystemQueries: [],
      requiredAnchorTerms: ["大叔", "家務", "慢生活"],
      normalAnchorTerms: ["日常", "生活"],
      strictAcceptTerms: ["造型", "口哨"],
      normalAcceptTerms: ["頭髮"],
      rejectTerms: [],
      domainSummary: "幽默职场吐槽",
    } as any;
    applyPersonaGuardToSentimentHotStrategy({ strategy });
    expect(strategy.requiredAnchorTerms).not.toContain("大叔");
    expect(strategy.requiredAnchorTerms).not.toContain("家務");
    expect(strategy.primaryQueries).toEqual(expect.arrayContaining(["办公室", "枸杞茶", "工位"]));
    expect(strategy.primaryQueries.length).toBeGreaterThanOrEqual(5);
    expect(strategy.requiredAnchorTerms.length).toBeGreaterThanOrEqual(3);
    expect(resolveSentimentHotModelStrategyKeywords(strategy, "strict")).toEqual(
      expect.arrayContaining(["办公室", "枸杞茶", "工位"]),
    );
  });

  it("keeps short auto-repair object nouns when they do not contain the parent anchor", () => {
    const strategy = {
      primaryQueries: ["機油", "剎車片", "火星塞", "變速箱", "輪胎", "電瓶", "水泵", "冷氣"],
      broadQueries: ["汽車零件", "保養"],
      ecosystemQueries: [],
      requiredAnchorTerms: ["汽車維修", "修車", "配件"],
      normalAnchorTerms: ["汽車", "保養"],
      strictAcceptTerms: ["機油", "剎車片", "火星塞", "變速箱", "輪胎", "電瓶", "水泵", "冷氣", "鈑金", "底盤"],
      normalAcceptTerms: ["汽車零件", "保養"],
      rejectTerms: [],
      domainSummary: "資深汽車維修愛好者分享修車實操",
    } as any;
    applyPersonaGuardToSentimentHotStrategy({ strategy });
    expect(strategy.primaryQueries.length).toBeGreaterThanOrEqual(5);
    expect(strategy.primaryQueries).toEqual(expect.arrayContaining(["機油", "剎車片", "變速箱"]));
    expect(resolveSentimentHotModelStrategyKeywords(strategy, "strict").length).toBeGreaterThanOrEqual(8);
  });

  it("splits theme-name mashups but keeps real object nouns", () => {
    const strategy = {
      primaryQueries: ["二次元菜市場", "菜市場蔬菜", "動漫手辦"],
      broadQueries: ["二次元 撿漏"],
      ecosystemQueries: [],
      requiredAnchorTerms: ["二次元", "菜市場", "動漫", "撿漏"],
      normalAnchorTerms: ["市集"],
      strictAcceptTerms: ["二次元菜市場", "菜市場蔬菜"],
      normalAcceptTerms: ["動漫手辦"],
      rejectTerms: [],
    } as any;
    applyPersonaGuardToSentimentHotStrategy({ strategy });
    expect(strategy.primaryQueries).not.toContain("二次元菜市場");
    expect(strategy.primaryQueries).toContain("菜市場蔬菜");
    expect(strategy.primaryQueries).toContain("動漫手辦");
    expect(strategy.primaryQueries).toEqual(expect.arrayContaining(["二次元", "菜市場"]));
  });

  it("does not invent short object nouns from long compounds", () => {
    const keywords = resolveSentimentHotManualQueryKeywords([
      "汽車修理",
      "修車店",
      "煞車異響",
      "機油更換",
      "房貸審核規則",
    ], null, "strict");
    expect(keywords).not.toContain("修車");
    expect(keywords).not.toContain("機油");
    expect(keywords).not.toContain("房貸");
    expect(keywords).toEqual(expect.arrayContaining(["汽車修理", "修車店", "煞車異響"]));
    expect(keywords).not.toContain("房貸審核規則");
  });

  it("does not reject concrete objects just because another persona once overused them", () => {
    const keywords = resolveSentimentHotManualQueryKeywords(["環保袋", "動漫文化", "手辦"], null, "strict");
    expect(keywords).toContain("環保袋");
    expect(keywords).toContain("動漫文化");
    expect(keywords).toContain("手辦");
  });

  it("keeps a full object-noun keyword batch instead of collapsing to a few families", () => {
    const keywords = resolveSentimentHotManualQueryKeywords([
      "二次元手辦",
      "動漫谷子",
      "痛包",
      "立牌",
      "二手漫畫",
      "動漫周邊",
      "菜市場攤位",
      "菜市場蔬菜",
      "菜市場海鮮",
      "撿漏商品",
      "夜市攤",
      "生活市集",
      "動漫徽章",
      "角色周邊",
      "二手手辦",
      "谷子店",
      "痛包配件",
      "攤位青菜",
      "市集海鮮",
      "漫畫單行本",
      "便宜",
      "大叔",
      "煙火氣",
    ], null, "strict");
    expect(keywords.length).toBeGreaterThanOrEqual(12);
    expect(keywords).toContain("二次元手辦");
    expect(keywords).toContain("痛包");
    expect(keywords).toContain("立牌");
    expect(keywords).toContain("撿漏商品");
    expect(keywords).not.toContain("便宜");
    expect(keywords).not.toContain("大叔");
    expect(keywords).not.toContain("煙火氣");
  });

  it("keeps sibling object nouns so the reader can search them together", () => {
    const keywords = resolveSentimentHotManualQueryKeywords([
      "環保袋",
      "環保購物袋",
      "二次元周邊",
      "撿漏水果",
      "市井菜市場",
      "動漫周邊商品",
      "菜市場魚攤",
      "二次元貼紙",
    ], null, "strict");
    expect(keywords).toContain("環保袋");
    expect(keywords).toContain("環保購物袋");
    expect(keywords).toContain("二次元周邊");
    expect(keywords).toContain("撿漏水果");
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

  it("rejects unrelated recommendation cards returned by public Threads search", () => {
    const base = {
      id: "public-search-card",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo/post/public-search-card",
      author: "demo",
      media: [],
      hotScore: 1200,
      metrics: { source: "threads-search-page", query: "理发店" },
      capturedAt: new Date().toISOString(),
    };

    expect(candidateMatchesCurrentKeywords({
      ...base,
      content: "韩国商品现货到店，今天开放订购并提供完整说明。",
    } as any, ["理发师", "剪发"], "strict")).toBe(false);
    expect(candidateMatchesCurrentKeywords({
      ...base,
      content: "理发店分享剪发与染发设计案例，整理顾客常见需求。",
    } as any, ["理发师", "剪发"], "strict")).toBe(true);
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

  it("matches script variants without inventing unrelated industry synonyms", () => {
    const candidate = {
      id: "traditional-auto-repair",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@garage/post/traditional-auto-repair",
      author: "garage",
      content: "\u8acb\u554f\u6ce1\u6c34\u8eca\u7684\u6c7d\u8eca\u7dad\u4fee\u8cbb\u7528\u5927\u6982\u591a\u5c11\uff0c\u60f3\u627e\u53ef\u9760\u7684\u4fdd\u990a\u5ee0\u6aa2\u67e5\u5e95\u76e4\u3002",
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    };

    expect(candidateMatchesCurrentKeywords(candidate as any, ["汽车维修", "车辆保养"], "strict")).toBe(true);
    expect(candidateMatchesCurrentKeywords(candidate as any, ["汽修", "修車"], "strict")).toBe(false);
    expect(candidateMatchesCurrentKeywords(candidate as any, ["汽車維修", "車輛保養"], "strict")).toBe(true);
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

  it("prioritizes heat before publish time for gap filling", () => {
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

    expect(candidates.map((candidate) => candidate.id)).toEqual(["old-hot", "fresh-hot-30d"]);
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

  it("prioritizes a hotter older candidate over a fresher lower-heat candidate", () => {
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

    expect(candidates.map((candidate) => candidate.id)).toEqual(["older-higher-heat", "recent-lower-heat"]);
  });

  it("uses publish time and then text length when candidate heat is equal", () => {
    const now = Date.now();
    const baseContent = "海外金融市場近期持續討論信用卡週轉、銀行信貸與貸款利率，完整比較收入證明、負債比例、還款期限與每月現金流，提醒申請前先確認審核條件和長期成本。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "older-long",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@finance/post/older-long",
        author: "finance",
        content: `${baseContent} 這篇另外整理了銀行審核流程與風險提醒。`,
        media: [],
        hotScore: 5000,
        metrics: {},
        publishedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
        capturedAt: new Date(now).toISOString(),
      },
      {
        id: "newer-short",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@finance/post/newer-short",
        author: "finance",
        content: baseContent,
        media: [],
        hotScore: 5000,
        metrics: {},
        publishedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        capturedAt: new Date(now).toISOString(),
      },
      {
        id: "newer-long",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@finance/post/newer-long",
        author: "finance",
        content: `${baseContent} 同时补充实际案例、资料清单和风险提醒。`,
        media: [],
        hotScore: 5000,
        metrics: {},
        publishedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        capturedAt: new Date(now).toISOString(),
      },
    ] as any, 10, { keywords: ["海外金融", "银行信贷", "信用卡"], searchMode: "normal" });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["newer-long", "newer-short", "older-long"]);
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

  it("does not inject mechanically extracted persona phrases into a model strategy", () => {
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
    });

    expect(strategy.requiredAnchorTerms).toEqual(["\u52a8\u6f2b", "\u4e8c\u6b21\u5143"]);
    expect(strategy.primaryQueries).toEqual(["\u52a8\u6f2b\u65b0\u756a"]);
    expect(strategy.primaryQueries).not.toContain("\u523a\u9752");
    expect(strategy.primaryQueries).not.toContain("\u6295\u8d44\u7406\u8d22");
  });

  it("removes generic persona roles from model search and acceptance terms", () => {
    const strategy = {
      primaryQueries: ["\u5e2b\u5085", "\u8336\u6587\u5316"],
      broadQueries: ["\u4f7f\u7528", "\u54c1\u8336"],
      ecosystemQueries: ["\u9ad4\u9a57", "\u8336\u9053"],
      requiredAnchorTerms: ["\u5e2b\u5085", "\u8336\u6587\u5316"],
      normalAnchorTerms: ["\u5e2b\u5085", "\u54c1\u8336"],
      rejectTerms: [],
      strictAcceptTerms: ["\u5e2b\u5085", "\u8336\u5177"],
      normalAcceptTerms: ["\u5e2b\u5085", "\u8336\u9053"],
      domainSummary: "\u8336\u6587\u5316\u3001\u54c1\u8336\u8207\u8336\u5177\u4f7f\u7528",
    } as any;

    applyPersonaGuardToSentimentHotStrategy({
      strategy,
    });

    for (const terms of [
      strategy.primaryQueries,
      strategy.broadQueries,
      strategy.ecosystemQueries,
      strategy.requiredAnchorTerms,
      strategy.normalAnchorTerms,
      strategy.strictAcceptTerms,
      strategy.normalAcceptTerms,
      strategy.personaGuardTerms,
    ]) {
      expect(terms).not.toContain("\u5e2b\u5085");
    }
    expect(strategy.primaryQueries).toContain("\u8336\u6587\u5316");
    expect(strategy.strictAcceptTerms).toContain("\u8336\u5177");
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

  it("accepts a concrete primary domain phrase in strict mode", () => {
    const candidate = {
      id: "fresh-tea-culture",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@tea/post/fresh-tea-culture",
      author: "tea",
      content: "台灣客家茶文化館最近整理新的茶席展覽，介紹不同茶葉的保存方式、沖泡水溫、茶具選擇與品茶禮儀，也分享在家建立日常茶席的實際經驗。",
      media: [],
      hotScore: 5000,
      metrics: { query: "茶文化" },
    } as any;
    const strategy = {
      primaryQueries: ["茶文化", "品茶心得"],
      broadQueries: ["退休生活"],
      ecosystemQueries: ["文化活動"],
      requiredAnchorTerms: ["茶葉", "茶具", "品茶", "茶道", "茶席"],
      normalAnchorTerms: ["茶飲", "茶器", "茶室"],
      rejectTerms: [],
      strictAcceptTerms: ["茶葉", "茶具", "品茶", "茶道", "茶席"],
      normalAcceptTerms: ["茶飲", "茶器", "茶室"],
      personaGuardTerms: ["茶文化"],
      domainSummary: "茶文化、品茶與茶具使用",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(true);
  });

  it("does not accept unrelated content through a broad strict strategy phrase", () => {
    const candidate = {
      id: "unrelated-retirement",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@life/post/unrelated-retirement",
      author: "life",
      content: "退休生活規劃需要先整理醫療保障、現金流、家庭支出與長期照護安排，這篇內容只討論財務準備、居家安全、運動習慣和規律作息。",
      media: [],
      hotScore: 5000,
      metrics: { query: "退休生活" },
    } as any;
    const strategy = {
      primaryQueries: ["茶文化", "品茶心得"],
      broadQueries: ["退休生活"],
      ecosystemQueries: ["文化活動"],
      requiredAnchorTerms: ["茶葉", "茶具", "品茶", "茶道", "茶席"],
      normalAnchorTerms: ["茶飲", "茶器", "茶室"],
      rejectTerms: [],
      strictAcceptTerms: ["茶葉", "茶具", "品茶", "茶道", "茶席"],
      normalAcceptTerms: ["茶飲", "茶器", "茶室"],
      personaGuardTerms: ["茶文化"],
      domainSummary: "茶文化、品茶與茶具使用",
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(false);
  });

  it("rejects a shared candidate collected by another persona query", () => {
    const strategy = {
      primaryQueries: ["台湾美食", "夜市小吃"],
      broadQueries: ["餐厅活动"],
      ecosystemQueries: ["美食趋势"],
      requiredAnchorTerms: ["台湾美食", "夜市小吃", "台北餐厅"],
      normalAnchorTerms: ["美食", "小吃", "餐厅"],
      rejectTerms: [],
      strictAcceptTerms: ["台湾美食", "夜市小吃", "台北餐厅"],
      normalAcceptTerms: ["美食", "小吃", "餐厅"],
      domainSummary: "台湾餐饮热点",
    } as any;
    const candidate = {
      id: "foreign-persona-backfill",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo/post/foreign-persona-backfill",
      author: "demo",
      content: "这是一篇政治活动记录，正文只在最后顺带提到夜市小吃是否安全，核心内容与餐饮热点无关。",
      media: [],
      hotScore: 5000,
      metrics: { globalPersonaBackfill: true, query: "基层活动" },
    } as any;

    expect(candidateMatchesSentimentHotStrategyAnchors(candidate, strategy, "strict")).toBe(false);
    expect(candidateMatchesSentimentHotStrategyAnchors({
      ...candidate,
      metrics: { globalPersonaBackfill: true, query: "台湾美食推荐" },
    }, strategy, "strict")).toBe(true);
  });

  it("requires a specific topic phrase instead of a shared short action word in strict mode", () => {
    const keywords = [
      "\u8001\u94a2\u7b14\u4fee\u590d",
      "\u7b14\u5c16\u6253\u78e8",
      "\u58a8\u56ca\u6e05\u7406",
    ];
    const unrelated = {
      id: "generic-repair",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/generic-repair",
      author: "demo",
      content: "\u8fd9\u5f20\u7167\u7247\u5148\u505a\u753b\u8d28\u4fee\u590d\uff0c\u518d\u6e05\u7406\u624b\u673a\u76f8\u518c\u548c\u6700\u8fd1\u5220\u9664\u7684\u6863\u6848\uff0c\u6574\u7406\u5b8c\u540e\u753b\u9762\u6e05\u6670\u5f88\u591a\u3002",
      media: [],
      hotScore: 9000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    } as const;
    const relevant = {
      ...unrelated,
      id: "pen-repair",
      sourceUrl: "https://www.threads.net/@demo/post/pen-repair",
      content: "\u8fd9\u6b21\u8001\u94a2\u7b14\u4fee\u590d\u5148\u62c6\u6d3b\u585e\u4e0a\u58a8\u7cfb\u7edf\uff0c\u518d\u505a\u7b14\u5c16\u6253\u78e8\u548c\u58a8\u56ca\u6e05\u7406\uff0c\u6700\u540e\u6d4b\u8bd5\u51fa\u58a8\u662f\u5426\u7a33\u5b9a\u3002",
    } as const;

    expect(candidateMatchesCurrentKeywords(unrelated, keywords, "strict")).toBe(false);
    expect(candidateMatchesCurrentKeywords(relevant, keywords, "strict")).toBe(true);
  });

  it("does not display hot candidates shorter than 25 Chinese characters", () => {
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

  it("uses a 25 Chinese character floor for hot candidates", () => {
    const base = {
      platform: "threads",
      author: "demo",
      media: [],
      hotScore: 9_000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    };
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        ...base,
        id: "under-25",
        sourceUrl: "https://www.threads.net/@demo/post/under-25",
        content: "\u7406".repeat(24),
      },
      {
        ...base,
        id: "at-25",
        sourceUrl: "https://www.threads.net/@demo/post/at-25",
        content: "\u7406".repeat(25),
      },
    ] as any, 10);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["at-25"]);
  });

  it("keeps concise authenticated Threads search posts above the hard heat floor", () => {
    const candidates = finalizeSentimentHotCandidatesForDisplay([{
      id: "short-threads-search",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/short-search",
      author: "demo",
      content: "茶具挑选与日常冲泡心得。",
      media: [],
      hotScore: 9000,
      metrics: { source: "threads-account-search" },
      capturedAt: new Date().toISOString(),
    }] as any, 10);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["short-threads-search"]);
  });

  it("rejects marked recent fallbacks when they are still below the heat gate", () => {
    const content = "茶文化活動分享茶葉保存、茶具選擇、茶席布置、沖泡水溫與品茶禮儀，也整理在家練習茶道時容易忽略的細節和實際經驗，並說明不同季節如何調整水溫、浸泡時間與茶葉用量。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "fresh-fallback",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@tea/post/fresh-fallback",
        author: "tea",
        content,
        media: [],
        hotScore: 80,
        publishedAt: new Date().toISOString(),
        metrics: {
          source: "threads-account-search",
          freshRelevantFallback: true,
          recentSearch: true,
          like_count: 80,
        },
        engagement: { likeCount: 80 },
      },
      {
        id: "qualified-hot",
        platform: "threads",
        sourceUrl: "https://www.threads.net/@tea/post/qualified-hot",
        author: "tea",
        content: `${content} 這篇近期獲得大量讀者互動與分享。`,
        media: [],
        hotScore: 5000,
        publishedAt: new Date().toISOString(),
        metrics: { viewCount: 5000 },
      },
    ] as any, 10, {
      keywords: ["茶文化", "茶葉", "茶具"],
      searchMode: "strict",
      freshnessDays: 15,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["qualified-hot"]);
  });

  it("still rejects unmarked low-heat candidates", () => {
    const candidates = finalizeSentimentHotCandidatesForDisplay([{
      id: "low-heat-unmarked",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@tea/post/low-heat-unmarked",
      author: "tea",
      content: "茶文化活動分享茶葉保存、茶具選擇、茶席布置、沖泡水溫與品茶禮儀，也整理在家練習茶道時容易忽略的細節和實際經驗。",
      media: [],
      hotScore: 80,
      publishedAt: new Date().toISOString(),
      metrics: { viewCount: 80 },
    }] as any, 10, {
      keywords: ["茶文化", "茶葉", "茶具"],
      searchMode: "strict",
      freshnessDays: 15,
    });

    expect(candidates).toHaveLength(0);
  });

  it("rejects Japanese copy even when it contains many Han characters", () => {
    expect(isChineseSentimentCandidate(
      "茶文化について詳しく紹介します。茶葉の保存方法や茶具の選び方、茶席でのおもてなしを学びながら楽しめる内容です。",
    )).toBe(false);
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

  it("matches explicit content keywords without hard-coded industry expansion", () => {
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
    ])).toBe(false);
    expect(candidateMatchesCurrentKeywords(candidate as any, [
      "银行贷款",
      "信用卡债务",
      "贷款利率",
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
    ])).toBe(false);
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

  it("keeps off-persona Threads reader rows only when collecting for the global pool", () => {
    const input = {
      query: "汽車維修",
      keywords: ["汽車維修", "煞車保養"],
      sourceUrl: "https://www.threads.com/search?q=%E6%B1%BD%E8%BB%8A%E7%B6%AD%E4%BF%AE",
      text: `
Search Threads
[Demo Cook](https://www.threads.com/@demo_cook)
[08/14/2026](https://www.threads.com/@demo_cook/post/global123)
今天分享餐厅后厨的备料流程和厨师排班经验，完整记录食材采购、烹饪火候以及高峰期团队协作方法。
1200
80
`,
    };
    expect(parseThreadsReaderSearchMarkdownCandidates(input)).toHaveLength(0);
    const recycled = parseThreadsReaderSearchMarkdownCandidates({ ...input, includeUnmatched: true });
    expect(recycled).toHaveLength(1);
    expect(recycled[0].metrics.matchedKeywords).toEqual([]);
    expect(recycled[0].hotScore).toBeGreaterThanOrEqual(500);
  });

  it("extracts prefetched Barcelona searchResults from Threads HTML without a browser", () => {
    const html = `prefix {"data":{"searchResults":{"inform_module":null,"tag_info":null,"edges":[{"node":{"thread":{"id":"1","thread_items":[{"post":{"id":"1_2","code":"DbBAGPfk7XS","like_count":663,"taken_at":1784552915,"user":{"username":"168_0804"},"caption":{"text":"女子之身 能屈能伸 可以吃苦 也有能力享受幸福"},"text_post_app_info":{"direct_reply_count":25,"repost_count":1,"reshare_count":57}}}]}}}]}}} suffix`;
    const payload = extractThreadsSearchPrefetchPayload(html);
    const candidates = parseThreadsGraphqlSearchPayload({ payload, query: "女性力量", keywords: ["女性力量"] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].author).toBe("168_0804");
    expect(candidates[0].hotScore).toBeGreaterThanOrEqual(500);
    const markdown = buildSpiderSearchMarkdownFromHotCandidates(candidates);
    expect(markdown).toContain("Search • Threads");
    expect(markdown).toContain("/post/DbBAGPfk7XS");
    expect(markdown).toContain("讚 663");
  });

  it("extracts Threads prefetch JSON even when post text contains braces", () => {
    const html = `prefix {"data":{"searchResults":{"inform_module":null,"edges":[{"node":{"thread":{"id":"1","thread_items":[{"post":{"id":"1_2","code":"BracePost1","like_count":880,"taken_at":1784552915,"user":{"username":"brace_user"},"caption":{"text":"修車店今天報價含 {原廠零件} 跟 } 收尾說明，煞車油要換了"},"text_post_app_info":{"direct_reply_count":12,"repost_count":1,"reshare_count":4}}}]}}}]}}} suffix`;
    const payload = extractThreadsSearchPrefetchPayload(html);
    const candidates = parseThreadsGraphqlSearchPayload({ payload, query: "修車店", keywords: ["修車店"] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].author).toBe("brace_user");
    expect(candidates[0].content).toContain("原廠零件");
    expect(candidates[0].hotScore).toBeGreaterThanOrEqual(500);
  });

  it("does not treat an empty Threads SERP as a login wall", () => {
    const html = `Search • Threads log in or sign up for threads {"data":{"searchResults":{"inform_module":null,"tag_info":null,"edges":[],"page_info":{"end_cursor":null,"has_next_page":false}}}} 查無結果。`;
    expect(threadsHtmlLooksLikeEmptySearch(html)).toBe(true);
    expect(readerBodyLooksLikeLoginWall(html)).toBe(false);
    expect(readerMarkdownLooksEmpty(html)).toBe(true);
    expect(anonymousReaderRetryReason({ ok: false, status: 204, headers: {}, body: html })).toBe("empty_public_page");
  });

  it("extracts hydration posts even when they sit outside the first searchResults blob", () => {
    const html = `shell {"data":{"searchResults":{"edges":[]}}} later {"node":{"thread":{"id":"9","thread_items":[{"post":{"id":"9_1","code":"HydraPost1","like_count":640,"taken_at":1784552915,"user":{"username":"hydra_user"},"caption":{"text":"環保袋今天補貨了，帆布材質很好裝"},"text_post_app_info":{"direct_reply_count":8,"repost_count":1,"reshare_count":3}}}]}}}`;
    const candidates = extractThreadsHydrationCandidatesFromHtml({ html, query: "環保袋", keywords: ["環保袋"] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].author).toBe("hydra_user");
    expect(candidates[0].sourceUrl).toContain("/post/HydraPost1");
  });

  it("treats Spider HTTP search shells as empty reader markdown", () => {
    expect(readerMarkdownLooksEmpty("Search • Threads")).toBe(true);
    expect(readerMarkdownLooksEmpty("Threads • Log in")).toBe(true);
    expect(readerMarkdownLooksEmpty("Title: Search • Threads\n\n[author](https://www.threads.com/@a/post/abc)\n正文")).toBe(false);
  });

  it("wraps rendered Threads markdown with the Jina Search header", () => {
    expect(formatPublicThreadsReaderMarkdown("[go](https://www.threads.com/@go/post/abc)\n女性力量")).toContain("Search • Threads");
    expect(formatPublicThreadsReaderMarkdown("Search • Threads\n\nkeep")).toBe("Search • Threads\n\nkeep");
  });

  it("writes Spider reader output to a markdown file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiment-reader-md-"));
    vi.stubEnv("TOOL_R18_RUNTIME_DIR", dir);
    const filePath = persistSentimentReaderMarkdown(
      "https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E5%8A%9B%E9%87%8F",
      "Search • Threads\n\n[go](https://www.threads.com/@go/post/abc)\n女性力量正文",
      { crawler: "spider-markdown" },
    );
    const text = fs.readFileSync(filePath, "utf8");
    expect(filePath.endsWith(".md")).toBe(true);
    expect(text).toContain("crawler: spider-markdown");
    expect(text).toContain("Search • Threads");
    expect(text).toContain("女性力量正文");
  });

  it("normalizes rendered ISO dates into Jina markdown and parses them", () => {
    const markdown = formatPublicThreadsReaderMarkdown(`
搜尋 • Threads
[ginger_nov](https://www.threads.com/@ginger_nov)
[2026-8-2](https://www.threads.com/@ginger_nov/post/DbiqVm9ASMN)
其實對年長女性的這種無法自控的雌競心態我會視而不見，50歲以上女性成長的環境對人格價值觀的塑造花了許多時間。
讚 1041
留言 29
`);
    expect(markdown).toContain("[08/02/2026](https://www.threads.com/@ginger_nov/post/DbiqVm9ASMN)");
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "女性成長",
      keywords: ["女性成長"],
      includeUnmatched: true,
      sourceUrl: "https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E6%88%90%E9%95%B7",
      text: markdown,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].sourceUrl).toContain("/post/DbiqVm9ASMN");
    expect(candidates[0].content).toContain("女性成長");
    expect(candidates[0].content).not.toContain("讚 1041");
    expect(candidates[0].content).not.toContain("留言 29");
  });

  it("parses Spider public-render markdown that uses Jina date links", () => {
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "女性獨立",
      keywords: ["女性獨立", "女性力量"],
      sourceUrl: "https://www.threads.com/search?q=%E5%A5%B3%E6%80%A7%E7%8D%A8%E7%AB%8B",
      text: `
Search • Threads

[zhengzheng_yeh](https://www.threads.com/@zhengzheng_yeh)
[07/28/2026](https://www.threads.com/@zhengzheng_yeh/post/DbUYPBkkkyg)
陳珮騏 女性獨立則天地皆寬 經濟上行時期的美感真的很能打動人
5323
80
`,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].author).toBe("zhengzheng_yeh");
    expect(candidates[0].sourceUrl).toContain("/post/DbUYPBkkkyg");
    expect(candidates[0].hotScore).toBeGreaterThanOrEqual(500);
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

  it("parses current Threads reader media cards and derives their real publish time", () => {
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "理发店",
      keywords: ["理发店", "理发", "剪发"],
      sourceUrl: "https://www.threads.com/search?q=%E7%90%86%E5%8F%91%E5%BA%97",
      text: `
Search • Threads

[![Image 1: demo_barber's profile picture](https://cdn.example.com/avatar.jpg)](http://www.threads.com/@demo_barber)
今天理发店分享一组短发剪发与染发设计，整理适合夏季的发型建议和护理重点。
Translate
[![Image 2](https://cdn.example.com/post.jpg)](http://www.threads.com/@demo_barber/post/Db1_1vjk4_j/media)
699
77
4
308
`,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceUrl).toBe("http://www.threads.com/@demo_barber/post/Db1_1vjk4_j");
    expect(candidates[0].publishedAt).toBe("2026-08-10T02:59:55.936Z");
    expect(candidates[0].metrics.publishedAtSource).toBe("threads_shortcode_snowflake");
    expect(candidates[0].metrics.raw_engagement_signals).toEqual([699, 77, 4, 308]);
    expect(candidates[0].hotScore).toBe(1088);
  });

  it("keeps concise public Threads posts when verified heat stays above the hard floor", () => {
    const candidates = parseThreadsReaderSearchMarkdownCandidates({
      query: "\u526a\u9aee",
      keywords: ["\u526a\u9aee", "\u9aee\u578b"],
      sourceUrl: "https://www.threads.com/search?q=%E5%89%AA%E9%AB%AE",
      text: `
Search Threads

[![Image 1: demo_barber's profile picture](https://cdn.example.com/avatar.jpg)](https://www.threads.com/@demo_barber)
\u9019\u7a2e\u9aee\u578b\u771f\u7684\u526a\u5f97\u51fa\u4f86\u55ce\ud83d\ude02
Sorry, we're having trouble playing this video.
[![Image 2](https://cdn.example.com/post.jpg)](https://www.threads.com/@demo_barber/post/Db1_1vjk4_j/media)
155
51
12
540
`,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].hotScore).toBe(758);
    expect(candidates[0].content).toBe("\u9019\u7a2e\u9aee\u578b\u771f\u7684\u526a\u5f97\u51fa\u4f86\u55ce\ud83d\ude02");
  });

  it("parses Threads account-search GraphQL posts with real engagement totals", () => {
    const candidates = parseThreadsGraphqlSearchPayload({
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
                    taken_at: 1784278800,
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
      hotScore: 4321,
      metrics: {
        source: "threads-account-search",
        like_count: 954,
        comment_count: 68,
        repost_count: 92,
        reshare_count: 58,
        share_count: 58,
        view_count: 4321,
        realEngagementTotal: 4321,
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

  it("keeps only the largest GraphQL image version for each carousel asset", () => {
    const candidates = parseThreadsGraphqlSearchPayload({
      query: "笑話",
      keywords: ["笑話"],
      payload: {
        data: {
          searchResults: {
            edges: [{
              node: {
                thread_items: [{
                  post: {
                    pk: "3925594288747063999",
                    code: "CarouselDedup",
                    taken_at: Math.floor(Date.now() / 1000) - 3600,
                    canonical_url: "https://www.threads.com/@vito50410/post/CarouselDedup",
                    user: { username: "vito50410" },
                    caption: {
                      text: "今天這則笑話真的太好笑了，現場同事聽完直接笑到不行，會議幹話直接破防。",
                    },
                    like_count: 120,
                    text_post_app_info: {
                      direct_reply_count: 8,
                      view_count: 1800,
                    },
                    carousel_media: [
                      {
                        image_versions2: {
                          candidates: [
                            { width: 1080, url: "https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg?stp=dst-jpg_e35_s1080x1080" },
                            { width: 640, url: "https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg?stp=dst-jpg_s640x640" },
                            { width: 320, url: "https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg?stp=dst-jpg_s320x320" },
                          ],
                        },
                      },
                      {
                        image_versions2: {
                          candidates: [
                            { width: 1080, url: "https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_e35_s1080x1080" },
                            { width: 640, url: "https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_s640x640" },
                            { width: 320, url: "https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_s320x320" },
                          ],
                        },
                      },
                    ],
                  },
                }],
              },
            }],
          },
        },
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].media.map((item) => item.url)).toEqual([
      "https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg?stp=dst-jpg_e35_s1080x1080",
      "https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_e35_s1080x1080",
    ]);
  });

  it("keeps a GraphQL carousel video as one video with its poster, not a fake extra image", () => {
    const candidates = parseThreadsGraphqlSearchPayload({
      query: "笑話",
      keywords: ["笑話"],
      payload: {
        data: {
          searchResults: {
            edges: [{
              node: {
                thread_items: [{
                  post: {
                    pk: "3925594288747064002",
                    code: "VideoPoster",
                    taken_at: Math.floor(Date.now() / 1000) - 1800,
                    canonical_url: "https://www.threads.com/@hkplaynd/post/VideoPoster",
                    user: { username: "hkplaynd" },
                    caption: { text: "今天這則笑話真的太好笑了，現場同事聽完直接笑到不行，會議幹話直接破防。" },
                    like_count: 40,
                    text_post_app_info: { direct_reply_count: 2, view_count: 800 },
                    carousel_media: [
                      {
                        image_versions2: {
                          candidates: [{ width: 720, url: "https://scontent.cdninstagram.com/v/t51.2885-15/poster1.jpg" }],
                        },
                        video_versions: [
                          { width: 720, url: "https://scontent.cdninstagram.com/v/t50.2886-16/clip1.mp4" },
                          { width: 360, url: "https://scontent.cdninstagram.com/v/t50.2886-16/clip1-small.mp4" },
                        ],
                      },
                      {
                        image_versions2: {
                          candidates: [{ width: 1080, url: "https://scontent.cdninstagram.com/v/t51.2885-15/still2.jpg" }],
                        },
                      },
                    ],
                  },
                }],
              },
            }],
          },
        },
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].media).toEqual([
      {
        type: "video",
        url: "https://scontent.cdninstagram.com/v/t50.2886-16/clip1.mp4",
        thumbnailUrl: "https://scontent.cdninstagram.com/v/t51.2885-15/poster1.jpg",
      },
      {
        type: "image",
        url: "https://scontent.cdninstagram.com/v/t51.2885-15/still2.jpg",
      },
    ]);
  });

  it("parses current Threads search hydration scripts with real engagement totals", () => {
    const scripts = [JSON.stringify({
      require: [["ScheduledServerJS", "handle", null, [{
        payload: {
          thread_items: [{
            post: {
              code: "HYDRATION123",
              user: { username: "storage_demo" },
              caption: {
                text: "\u6536\u7d0d\u6574\u7406\u5e2b\u5206\u4eab\u8863\u6ac3\u5206\u985e\u3001\u5eda\u623f\u6536\u7d0d\u8207\u65b7\u6368\u96e2\u6d41\u7a0b\uff0c\u4e26\u6574\u7406\u5c45\u5bb6\u52d5\u7dda\u8207\u65e5\u5e38\u7dad\u6301\u65b9\u6cd5\u3002",
              },
              taken_at: 1784764800,
              like_count: 820,
              text_post_app_info: {
                direct_reply_count: 90,
                repost_count: 60,
                reshare_count: 45,
                view_count: 12000,
              },
            },
          }],
        },
      }]]],
    })];

    const candidates = parseThreadsSearchHydrationPayloads({
      scripts,
      query: "\u6536\u7d0d\u6574\u7406",
      keywords: ["\u6536\u7d0d\u6574\u7406", "\u65b7\u6368\u96e2"],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceUrl: "https://www.threads.com/@storage_demo/post/HYDRATION123",
      hotScore: 12000,
      metrics: {
        source: "threads-account-search",
        view_count: 12000,
        realEngagementTotal: 12000,
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
    const fetchMock = vi.fn(async () => new Response(`
Title: Demo on Threads

## [Thread 186K views](https://www.threads.com/@demo/post/real-views)

Demo post body

19.5K

51

3.3K

1.7K
`, { status: 200 }));
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

  it("keeps authenticated detail rescue browser-only when the public Reader is disabled", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("public Reader must not run during authenticated detail rescue");
    });
    vi.stubGlobal("fetch", fetchMock);

    const [candidate] = await enrichThreadsCandidateDetails([{
      id: "browser-only-rescue",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo/post/browser-only-rescue",
      author: "demo",
      content: "这是一条需要使用当前登录态浏览器补全浏览量的中文热点候选内容。",
      media: [],
      hotScore: 80,
      metrics: { source: "threads-account-search", query: "地震" },
      engagement: { likeCount: 60, commentCount: 10, shareCount: 10 },
      capturedAt: new Date().toISOString(),
    }], { force: true, includeReader: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(candidate.hotScore).toBe(80);
  });

  it("accepts an authenticated normal-search card that exactly matches a two-character query", () => {
    expect(candidateMatchesCurrentKeywords({
      id: "short-query-match",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@demo/post/short-query-match",
      author: "demo",
      content: "台湾地震发生后许多民众讨论摇晃过程、余震风险与实际感受。",
      media: [],
      hotScore: 800,
      metrics: { source: "threads-account-search", query: "地震", recentSearch: false, matchedKeywords: ["地震"] },
      capturedAt: new Date().toISOString(),
    } as any, ["地震", "防灾"], "normal")).toBe(true);
  });

  it("keeps a detail-enriched post hidden when its body remains below the content floor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "## [Thread 12K views](https://www.threads.com/@tea/post/detail-rescue)",
      { status: 200 },
    )));
    const source = {
      id: "detail-rescue",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@tea/post/detail-rescue",
      author: "tea",
      content: "\u8336\u6587\u5316\u9928\u54c1\u8336\u8336\u9053\u5fc3\u5f97",
      media: [],
      hotScore: 191,
      metrics: { source: "threads-account-search" },
      engagement: { likeCount: 150, commentCount: 21, shareCount: 20 },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    } as any;

    expect(finalizeSentimentHotCandidatesForDisplay([source], 10, {
      keywords: ["\u8336\u6587\u5316", "\u54c1\u8336", "\u8336\u9053\u9ad4\u9a57"],
      searchMode: "strict",
    })).toHaveLength(0);

    const enriched = await enrichThreadsCandidateDetails([source], { force: true });
    expect(finalizeSentimentHotCandidatesForDisplay(enriched, 10, {
      keywords: ["\u8336\u6587\u5316", "\u54c1\u8336", "\u8336\u9053\u9ad4\u9a57"],
      searchMode: "strict",
    })).toHaveLength(0);
    expect(enriched[0].hotScore).toBe(12_000);
  });

  it("forces a fresh detail read when a cached candidate already has views", async () => {
    const fetchMock = vi.fn(async () => new Response(
      "## [Thread 99 views](https://www.threads.com/@demo/post/refresh-views)",
      { status: 200 },
    ));
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

  it("sorts all candidates at or above the 500 heat floor from high to low", () => {
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
    ] as any, 1, { keywords: ["醫療", "醫生", "醫院"] });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["account-accepted"]);
  });

  it("keeps the explicit 500 heat floor and rejects everything below it", () => {
    const base = {
      platform: "threads",
      author: "demo",
      media: [],
      capturedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      metrics: { source: "threads-reader-search" },
    } as const;
    const keyword = "热点";
    const content = "热点内容完整展示并包含足够长度的中文说明，确保通过内容质量和语言筛选。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      { ...base, id: "standard", author: "standard-author", sourceUrl: "https://www.threads.net/@demo/post/standard", content, hotScore: 1200 },
      { ...base, id: "fallback-700", author: "fallback-author", sourceUrl: "https://www.threads.net/@demo/post/fallback-700", content: `${content} 补足候选，包含不同的实操建议与案例细节。`, hotScore: 700 },
      { ...base, id: "floor-500", author: "floor-author", sourceUrl: "https://www.threads.net/@demo/post/floor-500", content: `${content} 最低候选，补充另一组不同的执行经验。`, hotScore: 500 },
      { ...base, id: "below-floor", author: "below-author", sourceUrl: "https://www.threads.net/@demo/post/below-floor", content: `${content} 不展示，低于硬性下限。`, hotScore: 499 },
    ] as any, 3, { keywords: [keyword] });

    expect(resolveSentimentHotDisplayHeatThreshold([
      { hotScore: 1200 }, { hotScore: 700 }, { hotScore: 500 }, { hotScore: 499 },
    ] as any, 3)).toBe(500);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["standard", "fallback-700", "floor-500"]);
  });

  it("supplements after final deduplication instead of counting duplicate high-score candidates", () => {
    const base = {
      platform: "threads",
      author: "demo",
      media: [],
      capturedAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      metrics: { source: "threads-reader-search" },
    } as const;
    const content = "热点内容完整展示并包含足够长度的中文说明，确保通过内容质量和语言筛选。";
    const candidates = finalizeSentimentHotCandidatesForDisplay([
      { ...base, id: "standard", sourceUrl: "https://www.threads.net/@demo/post/standard", content, hotScore: 1200 },
      { ...base, id: "standard-copy", sourceUrl: "https://www.threads.net/@demo/post/standard-copy", content, hotScore: 1150 },
      { ...base, id: "fallback", author: "fallback-author", sourceUrl: "https://www.threads.net/@demo/post/fallback", content: `${content} 补足另一组不同的执行经验。`, hotScore: 700 },
    ] as any, 2, { keywords: ["热点"] });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["standard", "fallback"]);
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

  it("keeps off-persona Instagram reader rows only when collecting for the global pool", () => {
    const input = {
      query: "汽車維修",
      keywords: ["汽車維修", "煞車保養"],
      sourceUrl: "https://www.instagram.com/explore/tags/car/",
      text: `
Title: Instagram
[demo_cook](https://www.instagram.com/demo_cook/)
[View post](https://www.instagram.com/p/DbdDxdkzbnq/)
今天分享餐厅后厨的备料流程和厨师排班经验，完整记录食材采购、烹饪火候以及高峰期团队协作方法。 1.2K likes
`,
    };
    expect(parseInstagramReaderSearchMarkdownCandidates(input)).toHaveLength(0);
    const recycled = parseInstagramReaderSearchMarkdownCandidates({ ...input, includeUnmatched: true });
    expect(recycled).toHaveLength(1);
    expect(recycled[0].metrics.matchedKeywords).toEqual([]);
    expect(recycled[0].hotScore).toBeGreaterThanOrEqual(500);
  });

  it("derives the original Instagram publication time from a public shortcode", () => {
    const candidates = parseInstagramReaderSearchMarkdownCandidates({
      query: "\u6c7d\u8f66",
      keywords: ["\u6c7d\u8f66"],
      sourceUrl: "https://www.instagram.com/explore/tags/car/",
      text: `
Title: Instagram
[car.demo](http://www.instagram.com/car.demo/)
[View post](http://www.instagram.com/p/DbdDxdkzbnq/)
\u6c7d\u8f66\u7ef4\u4fee\u548c\u8f66\u8f86\u4fdd\u517b\u7684\u771f\u5b9e\u4f53\u9a8c\u5206\u4eab\uff0c\u8bb0\u5f55\u8fd9\u6b21\u5904\u7406\u6545\u969c\u7684\u8fc7\u7a0b\u548c\u6210\u672c\u3002 1.2K likes
`,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].publishedAt).toBe("2026-07-31T10:33:17.218Z");
    expect((candidates[0].metrics as any).publishedAtSource).toBe("instagram_shortcode_snowflake");
  });

  it("parses authenticated Instagram posts with their original published time", () => {
    const takenAt = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const candidates = parseInstagramAuthenticatedSearchPayload({
      query: "\u53f0\u5317\u7f8e\u98df",
      keywords: ["\u53f0\u5317\u7f8e\u98df", "\u591c\u5e02\u5c0f\u5403"],
      payload: {
        data: {
          medias: [{
            media: {
              code: "FreshIgPost",
              taken_at: takenAt,
              user: { username: "food.demo" },
              caption: {
                text: "\u53f0\u5317\u7f8e\u98df\u65b0\u958b\u5e55\u7684\u591c\u5e02\u5c0f\u5403\u5e97\uff0c\u4eca\u5929\u5be6\u969b\u6392\u968a\u5f8c\u5206\u4eab\u9910\u9ede\u53e3\u5473\u3001\u50f9\u683c\u8207\u73fe\u5834\u6c23\u6c1b\uff0c\u9019\u662f\u8fd1\u671f\u771f\u5be6\u7528\u9910\u7d00\u9304\u3002",
              },
              like_count: 120,
              comment_count: 14,
              image_versions2: { candidates: [{ url: "https://example.com/food.jpg" }] },
            },
          }],
        },
      },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/p/FreshIgPost/",
      author: "food.demo",
      hotScore: 134,
    });
    expect(candidates[0].publishedAt).toBe(new Date(takenAt * 1000).toISOString());
    expect((candidates[0].metrics as any).source).toBe("instagram-account-search");
  });

  it("does not synthesize Instagram freshness when the original timestamp is missing", () => {
    const candidates = parseInstagramAuthenticatedSearchPayload({
      query: "\u53f0\u5317\u7f8e\u98df",
      keywords: ["\u53f0\u5317\u7f8e\u98df"],
      payload: {
        items: [{
          code: "MissingTime",
          user: { username: "food.demo" },
          caption: {
            text: "\u53f0\u5317\u7f8e\u98df\u5be6\u6e2c\u5167\u5bb9\u5f88\u5b8c\u6574\uff0c\u4f46\u9019\u7b46\u8cc7\u6599\u6c92\u6709\u539f\u59cb\u767c\u5e03\u6642\u9593\uff0c\u56e0\u6b64\u4e0d\u80fd\u9032\u5165\u56b4\u683c\u65b0\u9bae\u5ea6\u5019\u9078\u3002",
          },
          like_count: 200,
          comment_count: 20,
        }],
      },
    });
    expect(candidates).toEqual([]);
  });

  it("normalizes an explicit hotspot fetch platform", () => {
    expect(normalizeRequestedHotPlatform("threads")).toBe("threads");
    expect(normalizeRequestedHotPlatform("instagram")).toBe("instagram");
    expect(normalizeRequestedHotPlatform("both")).toBeUndefined();
  });

  it("keeps the full hotspot keyword-generation specification", () => {
    const source = fs.readFileSync(path.resolve("src/lib/sentiment-hot-importer.ts"), "utf8");
    expect(source).toContain("你是 Threads / Instagram 热点搜索策略模型");
    expect(source).toContain("人设名称只是对外称呼");
    expect(source).toContain("禁止把俚语化名称理解成色情、擦边或开车含义");
    expect(source).toContain("JSON 结构：");
    expect(source).toContain("primaryQueries");
    expect(source).toContain("rejectTerms");
    expect(source).toContain("domainSummary");
    expect(source).toContain("字段数量：primaryQueries 正好 10 个，domainExpansion 正好 10 个");
    expect(source).toContain("domainExpansion");
    expect(source).toContain("合计必须给出 20 个互不重复");
    expect(source).toContain("2-4 个汉字的具体物件、服务、场所、工具、产品或作品名为主");
    expect(source).toContain("禁止输出带这些后缀或整词的合成搜索词");
    expect(source).toContain("存股、融資、配息、當沖、槓桿、信用交易");
    expect(source).toContain("禁止单独输出空词");
    expect(source).toContain("生活状态词（慢生活、退休生活、健康生活、家务、居家清洁）");
    expect(source).toContain("maxOutputTokens: 1400");
    expect(source).toContain("const SENTIMENT_MODEL_KEYWORD_TARGET = 24");
    expect(source).toContain("人设名称只是对外称呼");
    expect(source).not.toContain("primaryQueries 恰好 12 个");
    expect(source).not.toContain("maxOutputTokens: 360");
    expect(source).not.toContain("茶具攻略、收纳教程、贷款分享");
  });

  it("indexes and reads the global hotspot pool by platform", () => {
    const source = fs.readFileSync(path.resolve("src/lib/sentiment-hot-importer.ts"), "utf8");
    expect(source).toContain("platform TEXT NOT NULL DEFAULT 'threads'");
    expect(source).toContain("idx_sentiment_hot_global_platform");
    expect(source).toContain("AND platform = ?");
    expect(source).toContain("platform: normalizeRequestedHotPlatform(candidate.platform) ?? \"threads\"");
    expect(source).toContain("if (platform && !candidateMatchesRequestedPlatform(candidate, platform)) continue");
  });

  it("never starts Threads and Instagram live search in the same request", () => {
    const missing = resolveHotLiveFetchTargets(undefined);
    const threads = resolveHotLiveFetchTargets("threads");
    const instagram = resolveHotLiveFetchTargets("instagram");
    const mixed = resolveHotLiveFetchTargets("both");
    expect(threads).toEqual({ threads: true, instagram: false });
    expect(instagram).toEqual({ threads: false, instagram: true });
    expect(missing).toEqual({ threads: true, instagram: false });
    expect(mixed).toEqual({ threads: true, instagram: false });
    for (const target of [missing, threads, instagram, mixed]) {
      expect(Number(target.threads) + Number(target.instagram)).toBe(1);
    }
  });

  it("does not force a platform contribution from low-heat candidates", () => {
    const now = new Date().toISOString();
    const content = "\u53f0\u5317\u7f8e\u98df\u591c\u5e02\u5c0f\u5403\u5be6\u6e2c\u5206\u4eab\uff0c\u5305\u542b\u65b0\u958b\u9910\u5ef3\u3001\u6392\u968a\u72c0\u6cc1\u3001\u9910\u9ede\u50f9\u683c\u8207\u73fe\u5834\u771f\u5be6\u7528\u9910\u5fc3\u5f97\u3002";
    const threads = {
      id: "threads-qualified",
      platform: "threads",
      sourceUrl: "https://www.threads.com/@food/post/qualified",
      author: "food",
      content,
      media: [],
      hotScore: 100,
      metrics: { source: "threads-account-search", freshRelevantFallback: true },
      publishedAt: now,
      capturedAt: now,
    } as any;
    const instagram = {
      ...threads,
      id: "instagram-qualified",
      platform: "instagram",
      sourceUrl: "https://www.instagram.com/p/qualified/",
      metrics: { source: "instagram-account-search", freshRelevantFallback: true },
    } as any;
    const result = ensureSentimentHotPlatformContributions(
      [threads, { ...threads, id: "threads-qualified-2", sourceUrl: "https://www.threads.com/@food/post/qualified-2", content: `${content}\u7b2c\u4e8c\u7bc7\u3002` }],
      [threads, instagram],
      2,
      { keywords: ["\u53f0\u5317\u7f8e\u98df"], searchMode: "strict", freshnessDays: 7 },
    );
    expect(result).toEqual([]);
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

  it("keeps an omitted Threads view label unknown after the post action row loads", () => {
    const detail = parseThreadsBrowserPostDetailMetrics({
      text: "Thread\ndemo\nNo replies yet",
      actionTexts: ["Like", "Comment", "Repost", "Share"],
    });

    expect(detail?.engagement.viewCount).toBeUndefined();
    expect(detail?.metrics.view_count).toBeUndefined();
    expect(detail?.hotScore).toBe(0);
  });

  it("overwrites existing named metrics when refreshing a stored Threads source", async () => {
    const fetchMock = vi.fn(async () => new Response(`
Title: Demo on Threads

# [Thread 250 views](https://www.threads.net/@demo/post/abc)

Demo post body

20

5

3

88
`, { status: 200 }));
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

  it("dedupes Threads CDN size variants and keeps the largest copy", () => {
    const media = parseThreadsDetailMediaMarkdown(`
![Image 1](https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg?stp=dst-jpg_s640x640)
![Image 2](https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg?stp=dst-jpg_e35_s1080x1080)
![Image 3](https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_s640x640)
![Image 4](https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg)
![Image 5](https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_e35_s1080x1080)
`);

    expect(media.map((item) => item.url)).toEqual([
      "https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg",
      "https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg?stp=dst-jpg_e35_s1080x1080",
    ]);
  });

  it("merges candidate media by asset identity instead of exact URL", () => {
    const media = mergeCandidateMedia(
      [
        { type: "image", url: "https://scontent.cdninstagram.com/v/t51.2885-15/333333333_n.jpg?stp=dst-jpg_s640x640" },
        { type: "image", url: "https://scontent.cdninstagram.com/v/t51.2885-15/444444444_n.jpg?stp=dst-jpg_s640x640" },
      ],
      [
        { type: "image", url: "https://scontent.cdninstagram.com/v/t51.2885-15/333333333_n.jpg?stp=dst-jpg_e35_s1080x1080" },
        { type: "image", url: "https://scontent.cdninstagram.com/v/t51.2885-15/444444444_n.jpg?stp=dst-jpg_s640x640" },
        { type: "image", url: "https://scontent.cdninstagram.com/v/t51.2885-15/555555555_n.jpg" },
      ],
    );

    expect(media.map((item) => item.url)).toEqual([
      "https://scontent.cdninstagram.com/v/t51.2885-15/333333333_n.jpg?stp=dst-jpg_e35_s1080x1080",
      "https://scontent.cdninstagram.com/v/t51.2885-15/444444444_n.jpg?stp=dst-jpg_s640x640",
      "https://scontent.cdninstagram.com/v/t51.2885-15/555555555_n.jpg",
    ]);
  });

  it("keeps only original hotspot post media and never repeats the same asset", () => {
    const originals = [
      "https://scontent.cdninstagram.com/v/t51.2885-15/111111111_n.jpg",
      "https://scontent.cdninstagram.com/v/t51.2885-15/222222222_n.jpg",
      "https://scontent.cdninstagram.com/v/t51.2885-15/333333333_n.jpg",
      "https://scontent.cdninstagram.com/v/t51.2885-15/444444444_n.jpg",
    ];
    const markdown = parseThreadsDetailMediaMarkdown(`
![Image 1: vito50410's profile picture](https://scontent.cdninstagram.com/v/t51.2885-19/profile_pic.jpg)
${originals.flatMap((url) => [
  `![Image](${url}?stp=dst-jpg_s640x640)`,
  `![Image](${url}?stp=dst-jpg_e35_s1080x1080)`,
  `![Image](${url})`,
]).join("\n")}
![Image](https://external-sea5-1.xx.fbcdn.net/emg1/v/t13/preview?url=https%3A%2F%2Fexample.com%2Fcover.jpg)
[![Image 9: reply_user's profile picture](https://cdn.example.com/reply-s150x150.jpg)](https://www.threads.net/@reply)
![Image 10](https://cdn.example.com/reply-body.jpg)
Log in to see more replies.
`);
    const graphql = parseThreadsGraphqlSearchPayload({
      query: "笑話",
      keywords: ["笑話"],
      payload: {
        data: {
          searchResults: {
            edges: [{
              node: {
                thread_items: [{
                  post: {
                    pk: "3925594288747064001",
                    code: "OriginalOnly",
                    taken_at: Math.floor(Date.now() / 1000) - 1800,
                    canonical_url: "https://www.threads.com/@vito50410/post/OriginalOnly",
                    user: { username: "vito50410" },
                    caption: { text: "今天這則笑話真的太好笑了，現場同事聽完直接笑到不行，會議幹話直接破防。" },
                    like_count: 88,
                    text_post_app_info: { direct_reply_count: 3, view_count: 900 },
                    image_versions2: {
                      candidates: [{ url: "https://scontent.cdninstagram.com/v/t51.82787-19/profile.jpg" }],
                    },
                    carousel_media: originals.map((url) => ({
                      image_versions2: {
                        candidates: [
                          { width: 1080, url: `${url}?stp=dst-jpg_e35_s1080x1080` },
                          { width: 640, url: `${url}?stp=dst-jpg_s640x640` },
                          { width: 320, url: `${url}?stp=dst-jpg_s320x320` },
                        ],
                      },
                    })),
                  },
                }],
              },
            }],
          },
        },
      },
    });

    const merged = mergeCandidateMedia(markdown, graphql[0]?.media || []);
    const identities = merged.map((item) => String(item.url).split("?")[0].split("/").pop());

    expect(graphql).toHaveLength(1);
    expect(merged.map((item) => item.url)).toEqual(originals);
    expect(identities).toEqual(["111111111_n.jpg", "222222222_n.jpg", "333333333_n.jpg", "444444444_n.jpg"]);
    expect(new Set(identities).size).toBe(identities.length);
    expect(merged.every((item) => !/profile_pic|s150x150|emg1|reply-body|s640x640|s320x320/i.test(item.url))).toBe(true);
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

  it("strips like/comment crumbs and excludes reverse-stance posts first", () => {
    expect(cleanSentimentCandidateContent("旺旺環保袋終於收到了 讚 3528 留言 72")).toBe("旺旺環保袋終於收到了");
    const reverse = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "reverse-1",
        platform: "threads",
        sourceUrl: "https://www.threads.com/@demo/post/reverse1",
        author: "demo",
        content: "有些人放屁的聲音是噗。我不會再把錢花在買動漫周邊公仔上了要存錢。",
        media: [],
        hotScore: 6800,
        metrics: { source: "threads-reader-search", publicSearch: true, query: "動漫周邊" },
        publishedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
      } as any,
    ], 10, { keywords: ["動漫周邊", "環保袋"], searchMode: "strict", freshnessDays: 30 });
    expect(reverse).toHaveLength(0);
  });

  it("drops garbage, useless, and completely unrelated posts", () => {
    const base = {
      platform: "threads",
      author: "demo",
      media: [],
      hotScore: 6800,
      metrics: { source: "threads-reader-search", publicSearch: true },
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
    };
    const dropped = finalizeSentimentHotCandidatesForDisplay([
      { ...base, id: "spam-1", sourceUrl: "https://www.threads.com/@demo/post/spam1", content: "哈哈哈哈哈 互关求赞 加微信领券" },
      { ...base, id: "unrelated-1", sourceUrl: "https://www.threads.com/@demo/post/unrel1", content: "今天足球比赛真的太精彩了，梅西这一脚世界波值得反复回看。", metrics: { ...base.metrics, query: "環保袋" } },
    ] as any, 10, { keywords: ["環保袋", "二次元周邊"], searchMode: "strict", freshnessDays: 30 });
    expect(dropped.map((item) => item.id)).toEqual([]);
    const kept = finalizeSentimentHotCandidatesForDisplay([
      {
        ...base,
        id: "keep-1",
        sourceUrl: "https://www.threads.com/@demo/post/keep1",
        content: "旺旺環保袋終於送到攤上了，市井菜市場裡還是這種袋子最耐用。",
      },
    ] as any, 10, { keywords: ["環保袋", "二次元周邊"], searchMode: "strict", freshnessDays: 30 });
    expect(kept.map((item) => item.id)).toEqual(["keep-1"]);
  });

  it("keeps two-character object-noun posts under the original relevance needles", () => {
    const kept = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "repair-keep",
        platform: "threads",
        sourceUrl: "https://www.threads.com/@demo/post/repair-keep",
        author: "demo",
        content: "昨天隨口跟媽媽抱怨修車要四千八，結果早上他就拿五千給我說媽媽幫你出。修車這行真的很貴。",
        media: [],
        hotScore: 6800,
        metrics: { source: "threads-reader-search", publicSearch: true, query: "修車" },
        publishedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
      } as any,
    ], 10, { keywords: ["修車", "汽車修理", "環保袋"], searchMode: "strict", freshnessDays: 30 });
    expect(kept.map((item) => item.id)).toEqual(["repair-keep"]);
    const authorOnly = finalizeSentimentHotCandidatesForDisplay([
      {
        id: "author-only",
        platform: "threads",
        sourceUrl: "https://www.threads.com/@demo/post/author-only",
        author: "修車達人",
        content: "今天足球比赛真的太精彩了，梅西这一脚世界波值得反复回看，完全不想聊别的。",
        media: [],
        hotScore: 6800,
        metrics: { source: "threads-reader-search", publicSearch: true, query: "修車" },
        publishedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
      } as any,
    ], 10, { keywords: ["修車", "汽車修理", "環保袋"], searchMode: "strict", freshnessDays: 30 });
    expect(authorOnly.map((item) => item.id)).toEqual([]);
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

  it("parses the current Threads search-card DOM using its canonical post link", () => {
    const candidates = parseThreadsSearchCardCandidates({
      query: "台股",
      keywords: ["台股", "股票投資"],
      cards: [{
        sourceUrl: "https://www.threads.com/@demo/post/current-card/media",
        text: [
          "demo",
          "台股",
          "50分鐘",
          "今天整理台股盤勢、股票投資風險與成交量變化，提醒大家不要追高並做好資金控管。",
          "1",
          "/",
          "2",
          "570",
          "22",
          "1",
          "7",
        ].join("\n"),
      }],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceUrl).toBe("https://www.threads.com/@demo/post/current-card");
    expect(candidates[0].content).toContain("台股盤勢");
    expect(candidates[0].hotScore).toBe(603);
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

  it("builds a domain-scoped cookie header without leaking cross-platform sessions", () => {
    const header = buildPlatformCookieHeader([
      { name: "sessionid", value: "threads-session", domain: ".threads.com" },
      { name: "csrftoken", value: "threads-csrf", domain: "www.threads.com" },
      { name: "sessionid", value: "instagram-session", domain: ".instagram.com" },
    ], "https://www.threads.com/@demo");

    expect(header).toContain("sessionid=threads-session");
    expect(header).toContain("csrftoken=threads-csrf");
    expect(header).not.toContain("instagram-session");
  });

  it("extracts Threads profile pagination payloads from server-rendered JSON", () => {
    const html = `<html><script type="application/json">${JSON.stringify({
      require: [{ result: { edges: [{ node: { thread_items: [{ post: {
        pk: "post-1",
        code: "CodeOne",
        user: { username: "demo" },
        canonical_url: "https://www.threads.com/@demo/post/CodeOne",
        text_post_app_info: { view_count: 20 },
      } }] } }], page_info: { end_cursor: "", has_next_page: false } } }],
    })}</script></html>`;

    const payloads = extractThreadsProfileHttpPayloads(html);
    expect(payloads).toHaveLength(1);
    expect(parseThreadsGraphqlProfilePagePayload({ username: "demo", payload: payloads[0] })).toMatchObject({
      hasNextPage: false,
      pageInfoResolved: true,
      posts: [{ pk: "post-1", viewCount: 20 }],
    });
  });

  it("extracts a Threads profile user id without using the target account's own login", () => {
    const html = `{"username":"sherryjim68","pk":"43951714650","full_name":"SherryJim"}`;
    expect(extractThreadsProfileUserId(html, "sherryjim68")).toBe("43951714650");
  });

  it("extracts public Threads follower and profile view counts from embedded profile JSON", () => {
    const html = `<html><script type="application/json">${JSON.stringify({
      user: {
        username: "barber_demo",
        follower_count: 1280,
        following_count: 44,
        text_post_app_profile_info: { profile_view_count: 61200 },
      },
    })}</script></html>`;

    expect(extractThreadsProfileUserStats(html, "barber_demo")).toEqual({
      followers: 1280,
      following: 44,
      recentViews: 61200,
    });
  });

  it("parses Threads text-feed connection GraphQL pages used by collector viewers", () => {
    const parsed = parseThreadsGraphqlProfilePagePayload({
      username: "sherryjim68",
      payload: {
        data: {
          xdt_api__v1__text_feed__user_id__profile__connection: {
            edges: [{
              node: {
                thread_items: [{
                  post: {
                    pk: "1",
                    code: "DcExtraPost12",
                    user: { username: "sherryjim68" },
                    canonical_url: "https://www.threads.com/@sherryjim68/post/DcExtraPost12",
                    like_count: 3,
                    text_post_app_info: { view_count: 88 },
                  },
                }],
              },
            }],
            page_info: { end_cursor: "", has_next_page: false },
          },
        },
      },
    });
    expect(parsed).toMatchObject({
      hasNextPage: false,
      pageInfoResolved: true,
      posts: [{ code: "DcExtraPost12", viewCount: 88 }],
    });
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
                        view_count: 4400,
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
      viewCount: 4400,
    }]);
    expect(parsed.endCursor).toBe("cursor-1");
    expect(parsed.hasNextPage).toBe(true);
  });

  it("counts only the top-level profile post when an attached poll shares the same thread edge", () => {
    const parsed = parseThreadsGraphqlProfilePagePayload({
      username: "chenyating119",
      payload: {
        data: {
          mediaData: {
            edges: [{
              node: {
                thread_items: [
                  {
                    post: {
                      pk: "3973492785394827329",
                      code: "DckrqLHCUBB",
                      user: { username: "chenyating119" },
                      caption: { text: "下午要喝什麼呢" },
                      canonical_url: "https://www.threads.com/@chenyating119/post/DckrqLHCUBB",
                      like_count: 18,
                      text_post_app_info: { direct_reply_count: 2, repost_count: 0, reshare_count: 0 },
                    },
                  },
                  {
                    post: {
                      pk: "3973493097056823191",
                      code: "DckrutXieeX",
                      user: { username: "chenyating119" },
                      caption: null,
                      canonical_url: "https://www.threads.com/@chenyating119/post/DckrutXieeX",
                      like_count: 2,
                      text_post_app_info: { direct_reply_count: 0, repost_count: 0, reshare_count: 0 },
                    },
                  },
                ],
              },
            }],
            page_info: { end_cursor: "", has_next_page: false },
          },
        },
      },
    });

    expect(parsed.posts.map((post) => post.code)).toEqual(["DckrqLHCUBB"]);
  });

  it("keeps profile post media together with the complete metric row", () => {
    const parsed = parseThreadsGraphqlProfilePagePayload({
      username: "chenyating119",
      payload: {
        data: {
          mediaData: {
            edges: [{
              node: {
                thread_items: [{
                  post: {
                    pk: "post-with-media",
                    code: "MediaPost1",
                    user: { username: "chenyating119" },
                    caption: { text: "带图片的推文" },
                    canonical_url: "https://www.threads.com/@chenyating119/post/MediaPost1",
                    like_count: 9,
                    image_versions2: {
                      candidates: [
                        { url: "https://cdn.example/small.jpg", width: 320 },
                        { url: "https://cdn.example/large.jpg", width: 1080 },
                      ],
                    },
                    text_post_app_info: {
                      direct_reply_count: 2,
                      repost_count: 1,
                      reshare_count: 3,
                      view_count: 42,
                    },
                  },
                }],
              },
            }],
            page_info: { end_cursor: "", has_next_page: false },
          },
        },
      },
    });

    expect(parsed.posts).toEqual([expect.objectContaining({
      code: "MediaPost1",
      viewCount: 42,
      mediaItems: [{ type: "image", url: "https://cdn.example/large.jpg" }],
    })]);
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

  it("parses authenticated Instagram profile totals and recent post metrics", () => {
    const refreshedAt = "2026-08-08T08:00:00.000Z";
    const metrics = parseInstagramProfileHotMetricsPayload({
      username: "demo.user",
      refreshedAt,
      payload: {
        data: {
          user: {
            username: "demo.user",
            edge_followed_by: { count: 1200 },
            edge_follow: { count: 88 },
            edge_owner_to_timeline_media: {
              count: 2,
              edges: [
                { node: { id: "1", shortcode: "PostA", taken_at_timestamp: 1_786_000_000, content_views_count: 321, edge_media_preview_like: { count: 30 }, edge_media_to_comment: { count: 4 } } },
                { node: { id: "2", shortcode: "ReelB", is_video: true, video_view_count: 900, edge_media_preview_like: { count: 50 }, edge_media_to_comment: { count: 7 } } },
              ],
            },
          },
        },
      },
    });

    expect(metrics).toMatchObject({
      platform: "instagram",
      username: "demo.user",
      followers: 1200,
      following: 88,
      posts: 2,
      likes: 80,
      comments: 11,
      views: 1221,
      scannedPosts: 2,
      complete: true,
      scope: "authenticated_full_profile",
    });
    expect(metrics.postMetrics?.map((row) => row.sourceUrl)).toEqual([
      "https://www.instagram.com/p/PostA/",
      "https://www.instagram.com/reel/ReelB/",
    ]);
    expect(metrics.postMetrics?.map((row) => row.viewCount)).toEqual([321, 900]);
  });

  it("leaves Instagram aggregate views unavailable when no post exposes a view metric", () => {
    const metrics = parseInstagramProfileHotMetricsPayload({
      username: "photo.account",
      payload: {
        data: {
          user: {
            username: "photo.account",
            edge_owner_to_timeline_media: {
              count: 1,
              edges: [{ node: { id: "1", shortcode: "PhotoA" } }],
            },
          },
        },
      },
    });

    expect(metrics.views).toBeUndefined();
    expect(metrics.postMetrics?.[0].viewCount).toBeUndefined();
  });

  it("does not report zero Instagram interactions when the profile response omits post edges", () => {
    const metrics = parseInstagramProfileHotMetricsPayload({
      username: "partial.user",
      payload: {
        data: {
          user: {
            username: "partial.user",
            follower_count: 90,
            media_count: 12,
          },
        },
      },
    });

    expect(metrics.followers).toBe(90);
    expect(metrics.posts).toBe(12);
    expect(metrics.likes).toBeUndefined();
    expect(metrics.comments).toBeUndefined();
    expect(metrics.complete).toBe(false);
    expect(metrics.scope).toBe("authenticated_profile_snapshot");
  });

  it("skips reposted or quoted Threads GraphQL profile rows", () => {
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
                      pk: "quote-post",
                      code: "DbQuote123",
                      canonical_url: "https://www.threads.com/@stevie875443/post/DbQuote123",
                      user: { username: "stevie875443" },
                      caption: { text: "這是引用別人的串文，不能算成本帳號原創全量數據。" },
                      like_count: 99,
                      text_post_app_info: {
                        direct_reply_count: 12,
                        repost_count: 8,
                        reshare_count: 5,
                        quoted_post: { pk: "original-foreign-post" },
                      },
                    },
                  }],
                },
              },
              {
                node: {
                  thread_items: [{
                    post: {
                      pk: "own-post",
                      code: "DbOwn123",
                      canonical_url: "https://www.threads.com/@stevie875443/post/DbOwn123",
                      user: { username: "stevie875443" },
                      caption: { text: "這是自己原創發布的串文，應該進入全量互動統計。" },
                      like_count: 31,
                      text_post_app_info: {
                        direct_reply_count: 4,
                        repost_count: 2,
                        reshare_count: 1,
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

    expect(parsed.posts).toHaveLength(1);
    expect(parsed.posts[0].code).toBe("DbOwn123");
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

  it("parses the exact permalink view count from Threads page data", () => {
    expect(parseThreadsPostViewCountFromHtml(`
      ["BarcelonaLoggedOutExpansionGating",[],{"enable_view_counts":false,"view_counts":175},7623]
    `)).toBe(175);
    expect(parseThreadsPostViewCountFromHtml("<html>no target view count</html>")).toBeUndefined();
  });

  it("verifies the authenticated Threads viewer instead of trusting cookie presence", () => {
    const html = `<script>{"viewer":{"fbid":"1","id":"2","username":"hiro504522"}}</script>`;
    expect(extractThreadsAuthenticatedViewerUsername(html)).toBe("hiro504522");
    expect(extractThreadsAuthenticatedViewerUsername("<html>logged out</html>")).toBe("");
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

  it("merges all Instagram HTTP feed pages and marks only an exhausted cursor complete", () => {
    const metrics = buildInstagramProfileHttpMetrics({
      username: "demo.user",
      reachedEnd: true,
      refreshedAt: "2026-08-21T00:00:00.000Z",
      profilePayload: {
        data: {
          user: {
            id: "user-1",
            username: "demo.user",
            follower_count: 100,
            following_count: 20,
            media_count: 2,
          },
        },
      },
      feedPages: [{
        more_available: false,
        items: [
          { pk: "1", code: "One", taken_at: 1_786_000_000, like_count: 4, comment_count: 1, play_count: 30 },
          { pk: "2", code: "Two", taken_at: 1_785_000_000, like_count: 6, comment_count: 2, view_count: 40 },
        ],
      }],
    });

    expect(metrics).toMatchObject({
      method: "http",
      complete: true,
      scope: "authenticated_full_profile",
      posts: 2,
      scannedPosts: 2,
      likes: 10,
      comments: 3,
      views: 70,
    });
  });
