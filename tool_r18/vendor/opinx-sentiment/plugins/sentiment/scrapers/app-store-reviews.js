import { mapWithConcurrency } from "./concurrency.js";
import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 3;
const APP_CONCURRENCY = 3;
const DEFAULT_MAX_APPS_PER_KEYWORD = 4;
const DEFAULT_MAX_REVIEWS_PER_APP = 20;
const DEFAULT_COUNTRIES = ["tw", "hk", "cn", "us"];

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxApps = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_APPS_PER_KEYWORD));
  const maxReviews = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_REVIEWS_PER_APP));
  return {
    maxAppsPerKeyword: Number.isFinite(maxApps) ? Math.min(10, Math.max(1, maxApps)) : DEFAULT_MAX_APPS_PER_KEYWORD,
    maxReviewsPerApp: Number.isFinite(maxReviews) ? Math.min(50, Math.max(1, maxReviews)) : DEFAULT_MAX_REVIEWS_PER_APP,
  };
}

function normalizeCountries(countries = DEFAULT_COUNTRIES) {
  const values = Array.isArray(countries) ? countries : String(countries || "").split(/[,\s，、;；]+/);
  const out = values
    .map(value => String(value || "").trim().toLowerCase())
    .filter(value => /^[a-z]{2}$/.test(value));
  return out.length ? [...new Set(out)] : DEFAULT_COUNTRIES;
}

function normalizeAppIds(appIds = []) {
  const values = Array.isArray(appIds) ? appIds : String(appIds || "").split(/[,\s，、;；]+/);
  return [...new Set(values.map(value => String(value || "").trim()).filter(value => /^\d{5,}$/.test(value)))];
}

function normalizeAppStoreDirectUrls(directUrls = []) {
  const values = Array.isArray(directUrls) ? directUrls : String(directUrls || "").split(/[\s，、]+/);
  const out = [];
  const seen = new Set();
  for (const value of values) {
    let parsed;
    try {
      parsed = new URL(String(value || "").trim());
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!["apps.apple.com", "itunes.apple.com"].includes(host)) continue;
    const match = parsed.pathname.match(/(?:^|\/)id(\d{5,})(?:$|[/?#])/i);
    const appId = match?.[1] || "";
    if (!appId) continue;
    const segments = parsed.pathname.split("/").map(segment => segment.trim()).filter(Boolean);
    const country = /^[a-z]{2}$/i.test(segments[0] || "") ? segments[0].toLowerCase() : "";
    const canonicalUrl = `https://apps.apple.com${country ? `/${country}` : ""}/app/id${appId}`;
    const key = `${country || "*"}:${appId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ appId, country, url: canonicalUrl, originalUrl: parsed.toString() });
  }
  return out;
}

function itunesSearchUrl(keyword, country = "tw", limit = DEFAULT_MAX_APPS_PER_KEYWORD) {
  const params = new URLSearchParams({
    term: keyword,
    country,
    entity: "software",
    media: "software",
    limit: String(Math.max(1, Math.min(20, Number(limit) || DEFAULT_MAX_APPS_PER_KEYWORD))),
  });
  return `https://itunes.apple.com/search?${params.toString()}`;
}

function appStoreReviewFeedUrl(appId, country = "tw") {
  return `https://itunes.apple.com/${country}/rss/customerreviews/id=${encodeURIComponent(appId)}/sortBy=mostRecent/json`;
}

function normalizeIsoDate(value) {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function parseItunesSearchApps(payload, { keyword = "", country = "tw", maxApps = DEFAULT_MAX_APPS_PER_KEYWORD } = {}) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results
    .map(item => ({
      appId: cleanText(item.trackId || item.track_id || "", 80),
      appName: cleanText(item.trackName || item.track_name || item.bundleId || "App Store App", 180),
      developer: cleanText(item.artistName || item.sellerName || "", 160),
      bundleId: cleanText(item.bundleId || "", 160),
      country,
      keyword,
      url: cleanText(item.trackViewUrl || item.track_view_url || "", 800),
      averageUserRating: Number(item.averageUserRating || item.average_user_rating || 0),
      userRatingCount: Number(item.userRatingCount || item.user_rating_count || 0),
    }))
    .filter(item => item.appId)
    .slice(0, Math.max(1, Math.min(20, Number(maxApps) || DEFAULT_MAX_APPS_PER_KEYWORD)));
}

function localizedLabel(value) {
  if (typeof value === "string") return value;
  return value?.label || value?.attributes?.label || "";
}

function parseAppStoreReviewFeed(payload, { app = {}, keyword = "", maxReviews = DEFAULT_MAX_REVIEWS_PER_APP } = {}) {
  const entries = Array.isArray(payload?.feed?.entry) ? payload.feed.entry : [];
  return entries
    .map(entry => {
      const attributes = entry?.["im:rating"]?.attributes || {};
      const rating = Number(localizedLabel(entry?.["im:rating"]) || attributes.label || 0);
      const title = cleanText(localizedLabel(entry?.title), 220);
      const content = cleanText(localizedLabel(entry?.content), 1600);
      const reviewId = cleanText(entry?.id?.label || entry?.id?.attributes?.["im:id"] || "", 160);
      const author = cleanText(entry?.author?.name?.label || "App Store reviewer", 160);
      const updated = normalizeIsoDate(localizedLabel(entry?.updated));
      if ((!title && !content) || (!reviewId && !content)) return null;
      return {
        appId: app.appId || "",
        appName: app.appName || "",
        country: app.country || "",
        keyword,
        reviewId,
        author,
        rating,
        version: cleanText(entry?.["im:version"]?.label || "", 80),
        title: title || `${app.appName || "App"} App Store review`,
        content,
        publishedAt: updated,
        url: app.url || `https://apps.apple.com/app/id${app.appId}`,
        developer: app.developer || "",
        searchRawAppCount: Number(app.searchRawAppCount || 0),
        directUrl: app.directUrl || "",
        directOriginalUrl: app.directOriginalUrl || "",
        collectionSource: app.collectionSource || "",
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(50, Number(maxReviews) || DEFAULT_MAX_REVIEWS_PER_APP)));
}

function countAppStoreReviewFeedRawEntries(payload = {}) {
  const entries = Array.isArray(payload?.feed?.entry) ? payload.feed.entry : [];
  return entries.filter(entry => {
    const reviewId = cleanText(entry?.id?.label || entry?.id?.attributes?.["im:id"] || "", 160);
    const title = cleanText(localizedLabel(entry?.title), 220);
    const content = cleanText(localizedLabel(entry?.content), 1600);
    return Boolean((reviewId || content) && (title || content));
  }).length;
}

function normalizeAppStoreKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function appStoreKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeAppStoreKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function appStoreValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeAppStoreKeywordText(value);
  return appStoreKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeAppStoreKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function reviewMatchesKeyword(review, keyword) {
  const text = `${review.appName || ""} ${review.title || ""} ${review.content || ""}`;
  return appStoreValueMatchesKeyword(text, keyword);
}

function appStoreReviewKeywordMatchSource(review = {}, keyword = "") {
  if (!appStoreKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", review.title],
    ["content", review.content],
    ["app_name", review.appName],
    ["developer", review.developer],
    ["author", review.author],
    ["url", review.url],
  ];
  const match = fields.find(([, value]) => appStoreValueMatchesKeyword(value, keyword));
  return match?.[0] || "app_search_keyword";
}

function appStoreReviewKeywordDiagnostics(review = {}, keyword = "") {
  const matchedKeyword = cleanText(review.matchedKeyword || keyword || "", 120);
  return {
    app_store_review_matched_keyword: matchedKeyword,
    app_store_review_keyword_match_source: appStoreReviewKeywordMatchSource(review, matchedKeyword),
  };
}

function appStoreReviewDedupeKey(review = {}) {
  const appId = cleanText(review.appId || "", 80);
  const reviewId = cleanText(review.reviewId || "", 160);
  if (appId && reviewId) return `app-store:${appId}:review:${reviewId}`;
  return [
    "app-store",
    appId,
    cleanText(review.country || "", 20),
    cleanText(review.author || "", 120),
    cleanText(review.title || "", 160),
    cleanText(review.content || "", 300),
    normalizeIsoDate(review.publishedAt || ""),
  ].map(part => String(part || "").toLowerCase()).join("|");
}

function appStoreReviewTermMatches(text = "", terms = []) {
  const source = normalizeAppStoreKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeAppStoreKeywordText(term);
    return needle && source.includes(needle);
  });
}

function appStoreReviewExperienceSignals(review = {}) {
  const text = cleanText(`${review.title || ""} ${review.content || ""} ${review.appName || ""} ${review.version || ""}`, 5000).toLowerCase();
  const rating = Number(review.rating || 0);
  const reasons = [];
  let score = 10;
  const out = {};
  const hasReviewId = Boolean(review.reviewId);
  const hasAppId = Boolean(review.appId);
  const hasMarket = Boolean(review.country);
  const hasVersion = Boolean(review.version);
  const evidenceTerms = appStoreReviewTermMatches(text, [
    "screenshot", "screen recording", "proof", "receipt", "invoice", "order", "transaction", "chat log", "timeline",
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "憑證", "凭证", "收據", "收据", "發票", "发票",
    "訂單", "订单", "交易紀錄", "交易记录", "聊天紀錄", "聊天记录", "時間線", "时间线",
  ]);
  const escalationTerms = appStoreReviewTermMatches(text, [
    "complaint", "report", "regulator", "consumer protection", "chargeback", "lawsuit", "legal", "media",
    "投訴", "投诉", "申訴", "申诉", "消保", "消費者保護", "消费者保护", "主管機關", "监管", "媒體", "媒体",
    "爆料", "退刷", "拒付", "法律", "提告",
  ]);
  const updateRegressionTerms = appStoreReviewTermMatches(text, [
    "after update", "latest update", "new version", "version", "updated", "upgrade", "regression",
    "更新後", "更新后", "新版", "新版本", "升級後", "升级后", "版本", "改版", "退步",
  ]);
  const outageTerms = appStoreReviewTermMatches(text, [
    "outage", "service unavailable", "server error", "cannot connect", "connection failed", "network error",
    "down", "offline", "blank screen", "white screen",
    "服務中斷", "服务中断", "伺服器錯誤", "服务器错误", "連不上", "连不上", "無法連線", "无法连接",
    "白屏", "黑屏", "打不開", "打不开", "無法開啟", "无法打开",
  ]);
  const responseGapTerms = appStoreReviewTermMatches(text, [
    "no response", "ignored", "unanswered", "support never replied", "customer service never replied",
    "未回覆", "未回复", "沒有回覆", "没有回复", "無回應", "无回应", "不處理", "不处理", "客服不回",
  ]);
  const developerResponseTerms = appStoreReviewTermMatches(text, [
    "developer response", "official response", "company response", "support replied", "customer service replied",
    "resolved", "fixed", "patched", "refund processed", "apology", "clarification", "statement",
    "開發者回覆", "开发者回复", "官方回應", "官方回应", "公司回應", "公司回应", "客服回覆", "客服回复",
    "已處理", "已处理", "已修復", "已修复", "退款完成", "道歉", "澄清", "聲明", "声明",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("app_store_review_id_signal", "review identity present", hasReviewId, 4);
  addSignal("app_store_app_id_signal", "app identity present", hasAppId, 4);
  addSignal("app_store_market_signal", "storefront market present", hasMarket, 4);
  addSignal("app_store_version_signal", "app version present", hasVersion, 6);
  addSignal("app_store_low_rating_signal", "low App Store rating", rating > 0 && rating <= 2, 18);
  addSignal("app_store_crash_signal", "crash or freeze issue", /crash|crashes|crashed|freeze|hang|閃退|闪退|當機|当机|卡死|崩潰|崩溃/i.test(text), 16);
  addSignal("app_store_login_account_signal", "login or account access issue", /login|sign in|account|password|verification|otp|locked|登入|登录|帳號|账号|密碼|密码|驗證|验证|封號|封号/i.test(text), 12);
  addSignal("app_store_payment_subscription_signal", "payment or subscription issue", /payment|billing|subscription|subscribe|auto-renew|charged|in-app purchase|扣款|付款|支付|訂閱|订阅|自動續費|自动续费|內購|内购/i.test(text), 14);
  addSignal("app_store_refund_signal", "refund or chargeback issue", /refund|chargeback|money back|退款|退費|退费|退貨|退货/i.test(text), 12);
  addSignal("app_store_customer_support_signal", "support or response failure", /customer support|customer service|support|no response|ignored|客服|售後|售后|未回覆|未回复|無回應|无回应/i.test(text), 10);
  addSignal("app_store_privacy_signal", "privacy or data concern", /privacy|tracking|personal data|data leak|data breach|個資|个人信息|個人資料|資料外洩|数据泄露|隱私|隐私|追蹤|跟踪/i.test(text), 14);
  addSignal("app_store_security_signal", "security or fraud concern", /security|hacked|phishing|fraud|scam|malware|安全|盜號|盗号|詐騙|诈骗|釣魚|钓鱼|惡意程式|恶意程序/i.test(text), 16);
  addSignal("app_store_performance_signal", "performance or battery issue", /slow|lag|performance|battery|overheat|loading|卡頓|卡顿|很慢|耗電|耗电|發熱|发热|載入|加载/i.test(text), 10);
  addSignal("app_store_functionality_signal", "broken feature or usability issue", /bug|broken|not working|cannot use|error|failed|功能|錯誤|错误|不能用|無法使用|无法使用|失敗|失败/i.test(text), 10);
  addSignal("app_store_evidence_language_signal", "review contains evidence language", evidenceTerms.length > 0, 12);
  addSignal("app_store_escalation_language_signal", "review contains escalation language", escalationTerms.length > 0, 12);
  addSignal("app_store_update_regression_signal", "update or version regression issue", updateRegressionTerms.length > 0, 12);
  addSignal("app_store_outage_language_signal", "outage or access failure language", outageTerms.length > 0, 12);
  addSignal("app_store_response_gap_signal", "support response gap language", responseGapTerms.length > 0, 10);
  addSignal("app_store_developer_response_signal", "developer or official response language", developerResponseTerms.length > 0, 8);

  const semanticSignals = [
    out.app_store_low_rating_signal,
    out.app_store_crash_signal,
    out.app_store_login_account_signal,
    out.app_store_payment_subscription_signal,
    out.app_store_refund_signal,
    out.app_store_customer_support_signal,
    out.app_store_privacy_signal,
    out.app_store_security_signal,
    out.app_store_performance_signal,
    out.app_store_functionality_signal,
    out.app_store_evidence_language_signal,
    out.app_store_escalation_language_signal,
    out.app_store_update_regression_signal,
    out.app_store_outage_language_signal,
    out.app_store_response_gap_signal,
    out.app_store_developer_response_signal,
  ].filter(Boolean).length;
  addSignal(
    "app_store_complete_crisis_narrative_signal",
    "complete review crisis narrative",
    semanticSignals >= 6
      && (out.app_store_low_rating_signal || out.app_store_refund_signal || out.app_store_security_signal || out.app_store_privacy_signal)
      && (out.app_store_evidence_language_signal || out.app_store_escalation_language_signal)
      && (out.app_store_response_gap_signal || out.app_store_developer_response_signal),
    10,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    app_store_experience_risk_score: boundedScore,
    app_store_experience_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    app_store_signal_count: signalFields.length,
    app_store_review_semantic_signal_count: semanticSignals,
    app_store_signal_reasons: [...new Set(reasons)].slice(0, 16),
    app_store_evidence_terms: evidenceTerms,
    app_store_escalation_terms: escalationTerms,
    app_store_update_regression_terms: updateRegressionTerms,
    app_store_outage_terms: outageTerms,
    app_store_response_gap_terms: responseGapTerms,
    app_store_developer_response_terms: developerResponseTerms,
  };
}

function insertAppStoreReview(review, { keyword, domainControls = {}, contentControls = {}, seenReviewKeys = null } = {}) {
  const dedupeKey = appStoreReviewDedupeKey(review);
  if (!dedupeKey) return 0;
  if (seenReviewKeys instanceof Set) {
    if (seenReviewKeys.has(dedupeKey)) return 0;
    seenReviewKeys.add(dedupeKey);
  }
  const text = `${review.title || ""} ${review.content || ""}`;
  const sentiment = review.rating > 0 && review.rating <= 2 ? "negative" : analyzeSentiment(text);
  const baseUrl = review.url || `https://apps.apple.com/app/id${review.appId}`;
  const reviewUrl = review.reviewId
    ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}reviewId=${encodeURIComponent(review.reviewId)}`
    : baseUrl;
  const result = insertSentimentItem({
    platform: "app_store",
    url: reviewUrl,
    title: `${review.appName ? `${review.appName}：` : ""}${review.title}`,
    content: review.content,
    author: review.author,
    sentiment,
    risk_level: assessRiskLevel({ title: review.title, content: review.content, sentiment }),
    keyword,
    keywords: [keyword, review.appName, "App Store"].filter(Boolean),
    published_at: review.publishedAt,
    ai_summary: review.content,
    metrics: {
      rating: review.rating,
      app_id: review.appId,
      app_name: review.appName,
      country: review.country,
      version: review.version,
      developer: review.developer,
    },
    evidence: {
      source_key: "appStoreReviews",
      evidence_type: "app_store_review",
      url: reviewUrl,
      title: review.title,
      content_text: review.content,
      metrics: {
        source: review.collectionSource || "apple_customer_reviews_rss",
        rating: review.rating,
        app_id: review.appId,
        app_name: review.appName,
        country: review.country,
        version: review.version,
        app_store_search_raw_app_count: Number(review.searchRawAppCount || 0),
        app_store_review_raw_entry_count: Number(review.reviewRawEntryCount || 0),
        app_store_direct_url: review.directUrl || "",
        app_store_direct_original_url: review.directOriginalUrl || "",
        app_store_direct_app_id: review.directUrl ? review.appId : "",
        source_kind: review.directUrl ? "app_store_direct_app_url" : "app_store_review_feed",
        collection_mode: review.directUrl ? "app_store_direct_url" : "app_store_review_feed",
        deep_collector: review.directUrl ? "app-store-direct-url" : "app-store-review-feed",
        direct_original_source_recovery: review.directUrl ? 1 : 0,
        ...appStoreReviewExperienceSignals(review),
        ...appStoreReviewKeywordDiagnostics(review, keyword),
        app_store_review_canonical_identity: dedupeKey,
        app_store_review_dedupe_key: dedupeKey,
        app_store_review_scan_dedupe_key: dedupeKey,
      },
    },
    source_type: "scraper",
    sourceKey: "appStoreReviews",
    domainControls,
    contentControls,
  });
  return result.inserted ? 1 : 0;
}

async function fetchJson(url, { proxyUrl = "", accept = "application/json" } = {}) {
  const res = await fetchPublicSource(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": accept,
      "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl);
  if (!res.ok) throw new Error(httpFailure(res));
  return res.json();
}

export async function scrapeAppStoreReviews(keywords, {
  proxyUrl = "",
  budget = {},
  since = "",
  countries = DEFAULT_COUNTRIES,
  appIds = [],
  directUrls = [],
  domainControls = {},
  contentControls = {},
} = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedCountries = normalizeCountries(countries);
  const configuredAppIds = normalizeAppIds(appIds);
  const directApps = normalizeAppStoreDirectUrls(directUrls);
  const { maxAppsPerKeyword, maxReviewsPerApp } = normalizeBudget(budget);
  const appMap = new Map();
  const seenReviewKeys = new Set();
  const failures = [];

  for (const appId of configuredAppIds) {
    for (const country of normalizedCountries) {
      appMap.set(`${country}:${appId}`, {
        appId,
        appName: `App ${appId}`,
        country,
        keyword: normalizedKeywords[0],
        url: `https://apps.apple.com/app/id${appId}`,
      });
    }
  }

  for (const directApp of directApps) {
    const targetCountries = directApp.country ? [directApp.country] : normalizedCountries;
    for (const country of targetCountries) {
      appMap.set(`${country}:${directApp.appId}`, {
        appId: directApp.appId,
        appName: `App ${directApp.appId}`,
        country,
        keyword: normalizedKeywords[0],
        url: directApp.url || `https://apps.apple.com/app/id${directApp.appId}`,
        directUrl: directApp.url || "",
        directOriginalUrl: directApp.originalUrl || directApp.url || "",
        collectionSource: "apple_customer_reviews_rss_direct_app_url",
        searchRawAppCount: 0,
      });
    }
  }

  const searchResults = await mapWithConcurrency(normalizedKeywords, KEYWORD_CONCURRENCY, async (keyword) => {
    const perKeyword = [];
    for (const country of normalizedCountries) {
      try {
        const payload = await fetchJson(itunesSearchUrl(keyword, country, maxAppsPerKeyword), { proxyUrl });
        const searchRawAppCount = Array.isArray(payload?.results) ? payload.results.length : Number(payload?.resultCount || 0);
        perKeyword.push(...parseItunesSearchApps(payload, { keyword, country, maxApps: maxAppsPerKeyword }).map(app => ({
          ...app,
          searchRawAppCount,
        })));
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ target: `itunes-search:${country}:${keyword}`, message });
      }
    }
    return perKeyword;
  });
  for (const app of searchResults.flat()) {
    const key = `${app.country}:${app.appId}`;
    if (!appMap.has(key)) appMap.set(key, app);
  }

  const reviewResults = await mapWithConcurrency([...appMap.values()], APP_CONCURRENCY, async (app) => {
    let inserted = 0;
    try {
      const payload = await fetchJson(appStoreReviewFeedUrl(app.appId, app.country), { proxyUrl });
      const reviewRawEntryCount = countAppStoreReviewFeedRawEntries(payload);
      const reviews = parseAppStoreReviewFeed(payload, { app, keyword: app.keyword, maxReviews: maxReviewsPerApp });
      for (const review of reviews) {
        if (!isAfterSince(review.publishedAt, since)) continue;
        const matchedKeyword = normalizedKeywords.find(keyword => reviewMatchesKeyword(review, keyword)) || app.keyword || normalizedKeywords[0];
        inserted += insertAppStoreReview({
          ...review,
          reviewRawEntryCount,
          matchedKeyword,
        }, { keyword: matchedKeyword, domainControls, contentControls, seenReviewKeys });
      }
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ target: `app-store-reviews:${app.country}:${app.appId}`, message });
    }
    return inserted;
  });

  return scraperResult(
    reviewResults.reduce((sum, count) => sum + Number(count || 0), 0),
    failures,
  );
}

export const __test__ = {
  normalizeBudget,
  normalizeCountries,
  normalizeAppIds,
  normalizeAppStoreDirectUrls,
  itunesSearchUrl,
  appStoreReviewFeedUrl,
  parseItunesSearchApps,
  parseAppStoreReviewFeed,
  countAppStoreReviewFeedRawEntries,
  normalizeAppStoreKeywordText,
  appStoreValueMatchesKeyword,
  reviewMatchesKeyword,
  appStoreReviewKeywordMatchSource,
  appStoreReviewKeywordDiagnostics,
  appStoreReviewDedupeKey,
  appStoreReviewExperienceSignals,
};
