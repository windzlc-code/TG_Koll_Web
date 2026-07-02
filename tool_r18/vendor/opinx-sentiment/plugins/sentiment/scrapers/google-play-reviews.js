import { mapWithConcurrency } from "./concurrency.js";
import { isAfterSince } from "./filters.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const KEYWORD_CONCURRENCY = 3;
const APP_CONCURRENCY = 3;
const DEFAULT_MAX_APPS_PER_KEYWORD = 5;
const DEFAULT_MAX_REVIEWS_PER_APP = 20;
const DEFAULT_LANGUAGES = ["zh-TW", "zh-HK", "en"];
const DEFAULT_COUNTRIES = ["tw", "hk", "us"];

function cleanText(value, max = 1200) {
  return String(value || "")
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxApps = Math.round(Number(budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_APPS_PER_KEYWORD));
  const maxReviews = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_REVIEWS_PER_APP));
  return {
    maxAppsPerKeyword: Number.isFinite(maxApps) ? Math.min(12, Math.max(1, maxApps)) : DEFAULT_MAX_APPS_PER_KEYWORD,
    maxReviewsPerApp: Number.isFinite(maxReviews) ? Math.min(50, Math.max(1, maxReviews)) : DEFAULT_MAX_REVIEWS_PER_APP,
  };
}

function normalizeLanguages(languages = DEFAULT_LANGUAGES) {
  const values = Array.isArray(languages) ? languages : String(languages || "").split(/[,\s，、;；]+/);
  const out = values.map(value => String(value || "").trim()).filter(Boolean);
  return out.length ? [...new Set(out)] : DEFAULT_LANGUAGES;
}

function normalizeCountries(countries = DEFAULT_COUNTRIES) {
  const values = Array.isArray(countries) ? countries : String(countries || "").split(/[,\s，、;；]+/);
  const out = values.map(value => String(value || "").trim().toLowerCase()).filter(value => /^[a-z]{2}$/.test(value));
  return out.length ? [...new Set(out)] : DEFAULT_COUNTRIES;
}

function normalizePackageIds(packageIds = []) {
  const values = Array.isArray(packageIds) ? packageIds : String(packageIds || "").split(/[,\s，、;；]+/);
  return [...new Set(values.map(value => String(value || "").trim()).filter(value => /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value)))];
}

function normalizeGooglePlayDirectUrls(directUrls = []) {
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
    if (host !== "play.google.com") continue;
    if (!/^\/store\/apps\/details/i.test(parsed.pathname || "")) continue;
    const packageId = cleanText(parsed.searchParams.get("id") || "", 180);
    if (!normalizePackageIds([packageId]).length) continue;
    const language = cleanText(parsed.searchParams.get("hl") || "", 40);
    const country = cleanText(parsed.searchParams.get("gl") || "", 20).toLowerCase();
    const normalizedCountry = /^[a-z]{2}$/.test(country) ? country : "";
    const key = `${language || "*"}:${normalizedCountry || "*"}:${packageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      packageId,
      language,
      country: normalizedCountry,
      url: googlePlayDetailUrl(packageId, { language: language || DEFAULT_LANGUAGES[0], country: normalizedCountry || DEFAULT_COUNTRIES[0] }),
      originalUrl: parsed.toString(),
    });
  }
  return out;
}

function googlePlaySearchUrl(keyword, { language = "zh-TW", country = "tw" } = {}) {
  const params = new URLSearchParams({ q: keyword, c: "apps", hl: language, gl: country.toUpperCase() });
  return `https://play.google.com/store/search?${params.toString()}`;
}

function googlePlayDetailUrl(packageId, { language = "zh-TW", country = "tw" } = {}) {
  const params = new URLSearchParams({ id: packageId, hl: language, gl: country.toUpperCase() });
  return `https://play.google.com/store/apps/details?${params.toString()}`;
}

function normalizeIsoDate(value) {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString();
}

function firstMatch(text, patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) return cleanText(match[1], 260);
  }
  return "";
}

function parseGooglePlaySearchApps(html, { keyword = "", language = "zh-TW", country = "tw", maxApps = DEFAULT_MAX_APPS_PER_KEYWORD } = {}) {
  const source = String(html || "");
  const seen = new Set();
  const apps = [];
  const push = (packageId, nearby = "") => {
    const id = cleanText(packageId, 180);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const title = firstMatch(nearby, [
      /aria-label=["']([^"']{2,160})["']/i,
      /title=["']([^"']{2,160})["']/i,
      /<span[^>]*>([^<]{2,160})<\/span>/i,
    ]);
    apps.push({
      packageId: id,
      appName: title || id,
      developer: "",
      keyword,
      language,
      country,
      url: googlePlayDetailUrl(id, { language, country }),
    });
  };
  for (const match of source.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9_.]+)[^"'<\s]*/g)) {
    const start = Math.max(0, match.index - 300);
    const end = Math.min(source.length, match.index + 500);
    push(match[1], source.slice(start, end));
    if (apps.length >= maxApps) break;
  }
  if (apps.length < maxApps) {
    for (const match of source.matchAll(/[?&]id=([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/g)) {
      push(match[1], source.slice(Math.max(0, match.index - 300), Math.min(source.length, match.index + 500)));
      if (apps.length >= maxApps) break;
    }
  }
  return apps.slice(0, Math.max(1, Math.min(20, Number(maxApps) || DEFAULT_MAX_APPS_PER_KEYWORD)));
}

function parseRating(value = "") {
  const match = String(value || "").match(/([1-5](?:[.,]\d)?)/);
  return match ? Number(match[1].replace(",", ".")) : 0;
}

function parseGooglePlayDetailReviews(html, { app = {}, keyword = "", maxReviews = DEFAULT_MAX_REVIEWS_PER_APP } = {}) {
  const source = String(html || "");
  const appName = firstMatch(source, [
    /<h1[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/h1>/i,
    /"name"\s*:\s*"([^"]{2,180})"/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  ]) || app.appName || app.packageId || "";
  const developer = firstMatch(source, [
    /"author"\s*:\s*\{\s*"@type"\s*:\s*"Organization"\s*,\s*"name"\s*:\s*"([^"]+)"/i,
    /<a[^>]+href=["'][^"']*\/store\/apps\/dev[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
  ]) || app.developer || "";
  const blocks = [
    ...source.matchAll(/<div[^>]+data-review-id=["']([^"']+)["'][^>]*>[\s\S]*?<\/div>/gi),
  ].map(match => ({ id: match[1], block: match[0] }));
  if (!blocks.length) {
    for (const match of source.matchAll(/(?:reviewId|review_id)["']?\s*[:=]\s*["']([^"']+)["'][\s\S]{0,800}/gi)) {
      blocks.push({ id: match[1], block: match[0] });
      if (blocks.length >= maxReviews) break;
    }
  }
  const reviews = [];
  for (const { id, block } of blocks) {
    const title = firstMatch(block, [
      /data-review-title=["']([^"']+)["']/i,
      /aria-label=["']([^"']{2,160})["']/i,
      /<h3[^>]*>([\s\S]*?)<\/h3>/i,
    ]);
    const content = firstMatch(block, [
      /data-review-text=["']([^"']+)["']/i,
      /<span[^>]+jsname=["'][^"']+["'][^>]*>([\s\S]{10,1800}?)<\/span>/i,
      /"comment"\s*:\s*"([^"]{10,1800})"/i,
    ]) || cleanText(block, 1600);
    const author = firstMatch(block, [
      /data-review-author=["']([^"']+)["']/i,
      /<div[^>]+class=["'][^"']*X5PpBb[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      /"authorName"\s*:\s*"([^"]+)"/i,
    ]) || "Google Play reviewer";
    const rating = parseRating(firstMatch(block, [
      /data-rating=["']([^"']+)["']/i,
      /aria-label=["'][^"']*?([1-5](?:[.,]\d)?)\s*(?:stars?|顆星|星)["']/i,
      /"rating"\s*:\s*([1-5](?:\.\d)?)/i,
    ]));
    const publishedAt = normalizeIsoDate(firstMatch(block, [
      /data-review-date=["']([^"']+)["']/i,
      /<time[^>]+datetime=["']([^"']+)["']/i,
      /"datePublished"\s*:\s*"([^"]+)"/i,
    ]));
    if (!content || content.length < 8) continue;
    reviews.push({
      packageId: app.packageId || "",
      appName,
      developer,
      language: app.language || "",
      country: app.country || "",
      keyword,
      reviewId: cleanText(id, 160),
      author,
      rating,
      version: firstMatch(block, [/data-app-version=["']([^"']+)["']/i, /"reviewAppVersion"\s*:\s*"([^"]+)"/i]),
      title: title || `${appName || "Google Play"} review`,
      content,
      publishedAt,
      url: app.url || googlePlayDetailUrl(app.packageId || "", { language: app.language, country: app.country }),
      searchRawAppCount: Number(app.searchRawAppCount || 0),
      directUrl: app.directUrl || "",
      directOriginalUrl: app.directOriginalUrl || "",
      collectionSource: app.collectionSource || "",
    });
    if (reviews.length >= maxReviews) break;
  }
  return reviews.slice(0, Math.max(1, Math.min(50, Number(maxReviews) || DEFAULT_MAX_REVIEWS_PER_APP)));
}

function countGooglePlaySearchRawApps(html = "") {
  const source = String(html || "");
  const seen = new Set();
  for (const match of source.matchAll(/\/store\/apps\/details\?id=([A-Za-z0-9_.]+)[^"'<\s]*/g)) {
    const id = cleanText(match[1], 180);
    if (id) seen.add(id);
  }
  for (const match of source.matchAll(/[?&]id=([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/g)) {
    const id = cleanText(match[1], 180);
    if (id) seen.add(id);
  }
  return seen.size;
}

function countGooglePlayDetailRawReviews(html = "") {
  const source = String(html || "");
  const ids = new Set();
  for (const match of source.matchAll(/<div[^>]+data-review-id=["']([^"']+)["'][^>]*>/gi)) {
    const id = cleanText(match[1], 160);
    if (id) ids.add(id);
  }
  for (const match of source.matchAll(/(?:reviewId|review_id)["']?\s*[:=]\s*["']([^"']+)["']/gi)) {
    const id = cleanText(match[1], 160);
    if (id) ids.add(id);
  }
  return ids.size;
}

function normalizeGooglePlayKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function googlePlayKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeGooglePlayKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function googlePlayValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeGooglePlayKeywordText(value);
  return googlePlayKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeGooglePlayKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function reviewMatchesKeyword(review, keyword) {
  const text = `${review.appName || ""} ${review.title || ""} ${review.content || ""}`;
  return googlePlayValueMatchesKeyword(text, keyword);
}

function googlePlayReviewKeywordMatchSource(review = {}, keyword = "") {
  if (!googlePlayKeywordNeedles(keyword).length) return "unknown";
  const fields = [
    ["title", review.title],
    ["content", review.content],
    ["app_name", review.appName],
    ["developer", review.developer],
    ["author", review.author],
    ["url", review.url],
  ];
  const match = fields.find(([, value]) => googlePlayValueMatchesKeyword(value, keyword));
  return match?.[0] || "app_search_keyword";
}

function googlePlayReviewKeywordDiagnostics(review = {}, keyword = "") {
  const matchedKeyword = cleanText(review.matchedKeyword || keyword || "", 120);
  return {
    google_play_review_matched_keyword: matchedKeyword,
    google_play_review_keyword_match_source: googlePlayReviewKeywordMatchSource(review, matchedKeyword),
  };
}

function googlePlayReviewDedupeKey(review = {}) {
  const packageId = cleanText(review.packageId || "", 180);
  const reviewId = cleanText(review.reviewId || "", 160);
  if (packageId && reviewId) return `google-play:${packageId}:review:${reviewId}`;
  return [
    "google-play",
    packageId,
    cleanText(review.language || "", 40),
    cleanText(review.country || "", 20),
    cleanText(review.author || "", 120),
    cleanText(review.title || "", 160),
    cleanText(review.content || "", 300),
    normalizeIsoDate(review.publishedAt || ""),
  ].map(part => String(part || "").toLowerCase()).join("|");
}

function googlePlayReviewTermMatches(text = "", terms = []) {
  const source = normalizeGooglePlayKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeGooglePlayKeywordText(term);
    return needle && source.includes(needle);
  });
}

function googlePlayReviewExperienceSignals(review = {}) {
  const text = cleanText(`${review.title || ""} ${review.content || ""} ${review.appName || ""} ${review.version || ""}`, 5000).toLowerCase();
  const rating = Number(review.rating || 0);
  const reasons = [];
  let score = 10;
  const out = {};
  const hasReviewId = Boolean(review.reviewId);
  const hasPackageId = Boolean(review.packageId);
  const hasLocale = Boolean(review.country || review.language);
  const hasVersion = Boolean(review.version);
  const evidenceTerms = googlePlayReviewTermMatches(text, [
    "screenshot", "screen recording", "proof", "receipt", "invoice", "order", "transaction", "chat log", "timeline",
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "憑證", "凭证", "收據", "收据", "發票", "发票",
    "訂單", "订单", "交易紀錄", "交易记录", "聊天紀錄", "聊天记录", "時間線", "时间线",
  ]);
  const escalationTerms = googlePlayReviewTermMatches(text, [
    "complaint", "report", "regulator", "consumer protection", "chargeback", "lawsuit", "legal", "media",
    "投訴", "投诉", "申訴", "申诉", "消保", "消費者保護", "消费者保护", "主管機關", "监管", "媒體", "媒体",
    "爆料", "退刷", "拒付", "法律", "提告",
  ]);
  const updateRegressionTerms = googlePlayReviewTermMatches(text, [
    "after update", "latest update", "new version", "version", "updated", "upgrade", "regression",
    "更新後", "更新后", "新版", "新版本", "升級後", "升级后", "版本", "改版", "退步",
  ]);
  const outageTerms = googlePlayReviewTermMatches(text, [
    "outage", "service unavailable", "server error", "cannot connect", "connection failed", "network error",
    "down", "offline", "blank screen", "white screen",
    "服務中斷", "服务中断", "伺服器錯誤", "服务器错误", "連不上", "连不上", "無法連線", "无法连接",
    "白屏", "黑屏", "打不開", "打不开", "無法開啟", "无法打开",
  ]);
  const responseGapTerms = googlePlayReviewTermMatches(text, [
    "no response", "ignored", "unanswered", "support never replied", "customer service never replied",
    "未回覆", "未回复", "沒有回覆", "没有回复", "無回應", "无回应", "不處理", "不处理", "客服不回",
  ]);
  const developerResponseTerms = googlePlayReviewTermMatches(text, [
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

  addSignal("google_play_review_id_signal", "review identity present", hasReviewId, 4);
  addSignal("google_play_package_id_signal", "package identity present", hasPackageId, 4);
  addSignal("google_play_locale_signal", "review locale present", hasLocale, 4);
  addSignal("google_play_version_signal", "app version present", hasVersion, 6);
  addSignal("google_play_low_rating_signal", "low Google Play rating", rating > 0 && rating <= 2, 18);
  addSignal("google_play_crash_signal", "crash or freeze issue", /crash|crashes|crashed|freeze|hang|force close|閃退|闪退|當機|当机|卡死|崩潰|崩溃/i.test(text), 16);
  addSignal("google_play_login_account_signal", "login or account access issue", /login|sign in|account|password|verification|otp|locked|登入|登录|帳號|账号|密碼|密码|驗證|验证|封號|封号/i.test(text), 12);
  addSignal("google_play_payment_subscription_signal", "payment or subscription issue", /payment|billing|subscription|subscribe|auto-renew|charged|in-app purchase|扣款|付款|支付|訂閱|订阅|自動續費|自动续费|內購|内购/i.test(text), 14);
  addSignal("google_play_refund_signal", "refund or chargeback issue", /refund|chargeback|money back|退款|退費|退费|退貨|退货/i.test(text), 12);
  addSignal("google_play_customer_support_signal", "support or response failure", /customer support|customer service|support|no response|ignored|客服|售後|售后|未回覆|未回复|無回應|无回应/i.test(text), 10);
  addSignal("google_play_privacy_signal", "privacy or data concern", /privacy|tracking|personal data|data leak|data breach|個資|个人信息|個人資料|資料外洩|数据泄露|隱私|隐私|追蹤|跟踪/i.test(text), 14);
  addSignal("google_play_security_signal", "security or fraud concern", /security|hacked|phishing|fraud|scam|malware|安全|盜號|盗号|詐騙|诈骗|釣魚|钓鱼|惡意程式|恶意程序/i.test(text), 16);
  addSignal("google_play_performance_signal", "performance or battery issue", /slow|lag|performance|battery|overheat|loading|卡頓|卡顿|很慢|耗電|耗电|發熱|发热|載入|加载/i.test(text), 10);
  addSignal("google_play_functionality_signal", "broken feature or usability issue", /bug|broken|not working|cannot use|error|failed|功能|錯誤|错误|不能用|無法使用|无法使用|失敗|失败/i.test(text), 10);
  addSignal("google_play_evidence_language_signal", "review contains evidence language", evidenceTerms.length > 0, 12);
  addSignal("google_play_escalation_language_signal", "review contains escalation language", escalationTerms.length > 0, 12);
  addSignal("google_play_update_regression_signal", "update or version regression issue", updateRegressionTerms.length > 0, 12);
  addSignal("google_play_outage_language_signal", "outage or access failure language", outageTerms.length > 0, 12);
  addSignal("google_play_response_gap_signal", "support response gap language", responseGapTerms.length > 0, 10);
  addSignal("google_play_developer_response_signal", "developer or official response language", developerResponseTerms.length > 0, 8);

  const semanticSignals = [
    out.google_play_low_rating_signal,
    out.google_play_crash_signal,
    out.google_play_login_account_signal,
    out.google_play_payment_subscription_signal,
    out.google_play_refund_signal,
    out.google_play_customer_support_signal,
    out.google_play_privacy_signal,
    out.google_play_security_signal,
    out.google_play_performance_signal,
    out.google_play_functionality_signal,
    out.google_play_evidence_language_signal,
    out.google_play_escalation_language_signal,
    out.google_play_update_regression_signal,
    out.google_play_outage_language_signal,
    out.google_play_response_gap_signal,
    out.google_play_developer_response_signal,
  ].filter(Boolean).length;
  addSignal(
    "google_play_complete_crisis_narrative_signal",
    "complete review crisis narrative",
    semanticSignals >= 6
      && (out.google_play_low_rating_signal || out.google_play_refund_signal || out.google_play_security_signal || out.google_play_privacy_signal)
      && (out.google_play_evidence_language_signal || out.google_play_escalation_language_signal)
      && (out.google_play_response_gap_signal || out.google_play_developer_response_signal),
    10,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    google_play_experience_risk_score: boundedScore,
    google_play_experience_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    google_play_signal_count: signalFields.length,
    google_play_review_semantic_signal_count: semanticSignals,
    google_play_signal_reasons: [...new Set(reasons)].slice(0, 16),
    google_play_evidence_terms: evidenceTerms,
    google_play_escalation_terms: escalationTerms,
    google_play_update_regression_terms: updateRegressionTerms,
    google_play_outage_terms: outageTerms,
    google_play_response_gap_terms: responseGapTerms,
    google_play_developer_response_terms: developerResponseTerms,
  };
}

function insertGooglePlayReview(review, { keyword, domainControls = {}, contentControls = {}, seenReviewKeys = null } = {}) {
  const dedupeKey = googlePlayReviewDedupeKey(review);
  if (!dedupeKey) return 0;
  if (seenReviewKeys instanceof Set) {
    if (seenReviewKeys.has(dedupeKey)) return 0;
    seenReviewKeys.add(dedupeKey);
  }
  const text = `${review.title || ""} ${review.content || ""}`;
  const sentiment = review.rating > 0 && review.rating <= 2 ? "negative" : analyzeSentiment(text);
  const baseUrl = review.url || googlePlayDetailUrl(review.packageId || "");
  const reviewUrl = review.reviewId
    ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}reviewId=${encodeURIComponent(review.reviewId)}`
    : baseUrl;
  const result = insertSentimentItem({
    platform: "google_play",
    url: reviewUrl,
    title: `${review.appName ? `${review.appName}：` : ""}${review.title}`,
    content: review.content,
    author: review.author,
    sentiment,
    risk_level: assessRiskLevel({ title: review.title, content: review.content, sentiment }),
    keyword,
    keywords: [keyword, review.appName, "Google Play"].filter(Boolean),
    published_at: review.publishedAt,
    ai_summary: review.content,
    metrics: {
      rating: review.rating,
      package_id: review.packageId,
      app_name: review.appName,
      country: review.country,
      language: review.language,
      version: review.version,
      developer: review.developer,
    },
    evidence: {
      source_key: "googlePlayReviews",
      evidence_type: "google_play_review",
      url: reviewUrl,
      title: review.title,
      content_text: review.content,
      metrics: {
        source: review.collectionSource || "google_play_public_page",
        rating: review.rating,
        package_id: review.packageId,
        app_name: review.appName,
        country: review.country,
        language: review.language,
        version: review.version,
        google_play_search_raw_app_count: Number(review.searchRawAppCount || 0),
        google_play_review_raw_entry_count: Number(review.reviewRawEntryCount || 0),
        google_play_direct_url: review.directUrl || "",
        google_play_direct_original_url: review.directOriginalUrl || "",
        google_play_direct_package_id: review.directUrl ? review.packageId : "",
        source_kind: review.directUrl ? "google_play_direct_app_url" : "google_play_public_page",
        collection_mode: review.directUrl ? "google_play_direct_url" : "google_play_public_page",
        deep_collector: review.directUrl ? "google-play-direct-url" : "google-play-public-page",
        direct_original_source_recovery: review.directUrl ? 1 : 0,
        ...googlePlayReviewExperienceSignals(review),
        ...googlePlayReviewKeywordDiagnostics(review, keyword),
        google_play_review_canonical_identity: dedupeKey,
        google_play_review_dedupe_key: dedupeKey,
        google_play_review_scan_dedupe_key: dedupeKey,
      },
    },
    source_type: "scraper",
    sourceKey: "googlePlayReviews",
    domainControls,
    contentControls,
  });
  return result.inserted ? 1 : 0;
}

async function fetchText(url, { proxyUrl = "" } = {}) {
  const res = await fetchPublicSource(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, proxyUrl);
  if (!res.ok) throw new Error(httpFailure(res));
  return res.text();
}

export async function scrapeGooglePlayReviews(keywords, {
  proxyUrl = "",
  budget = {},
  since = "",
  countries = DEFAULT_COUNTRIES,
  languages = DEFAULT_LANGUAGES,
  packageIds = [],
  appIds = [],
  directUrls = [],
  domainControls = {},
  contentControls = {},
} = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedCountries = normalizeCountries(countries);
  const normalizedLanguages = normalizeLanguages(languages);
  const configuredPackages = normalizePackageIds([...normalizePackageIds(packageIds), ...normalizePackageIds(appIds)]);
  const directApps = normalizeGooglePlayDirectUrls(directUrls);
  const { maxAppsPerKeyword, maxReviewsPerApp } = normalizeBudget(budget);
  const appMap = new Map();
  const seenReviewKeys = new Set();
  const failures = [];

  for (const packageId of configuredPackages) {
    for (const language of normalizedLanguages.slice(0, 2)) {
      for (const country of normalizedCountries.slice(0, 2)) {
        appMap.set(`${language}:${country}:${packageId}`, {
          packageId,
          appName: packageId,
          keyword: normalizedKeywords[0],
          language,
          country,
          url: googlePlayDetailUrl(packageId, { language, country }),
        });
      }
    }
  }

  for (const directApp of directApps) {
    const targetLanguages = directApp.language ? [directApp.language] : normalizedLanguages.slice(0, 2);
    const targetCountries = directApp.country ? [directApp.country] : normalizedCountries.slice(0, 2);
    for (const language of targetLanguages) {
      for (const country of targetCountries) {
        appMap.set(`${language}:${country}:${directApp.packageId}`, {
          packageId: directApp.packageId,
          appName: directApp.packageId,
          keyword: normalizedKeywords[0],
          language,
          country,
          url: googlePlayDetailUrl(directApp.packageId, { language, country }),
          directUrl: googlePlayDetailUrl(directApp.packageId, { language, country }),
          directOriginalUrl: directApp.originalUrl || directApp.url || "",
          collectionSource: "google_play_public_page_direct_app_url",
          searchRawAppCount: 0,
        });
      }
    }
  }

  const searchResults = await mapWithConcurrency(normalizedKeywords, KEYWORD_CONCURRENCY, async (keyword) => {
    const apps = [];
    for (const language of normalizedLanguages.slice(0, 2)) {
      for (const country of normalizedCountries.slice(0, 2)) {
        try {
          const html = await fetchText(googlePlaySearchUrl(keyword, { language, country }), { proxyUrl });
          const searchRawAppCount = countGooglePlaySearchRawApps(html);
          apps.push(...parseGooglePlaySearchApps(html, { keyword, language, country, maxApps: maxAppsPerKeyword }).map(app => ({
            ...app,
            searchRawAppCount,
          })));
        } catch (err) {
          failures.push({ target: `google-play-search:${language}:${country}:${keyword}`, message: formatSourceError(err, proxyUrl) });
        }
      }
    }
    return apps;
  });
  for (const app of searchResults.flat()) {
    const key = `${app.language}:${app.country}:${app.packageId}`;
    if (!appMap.has(key)) appMap.set(key, app);
  }

  const reviewResults = await mapWithConcurrency([...appMap.values()], APP_CONCURRENCY, async (app) => {
    let inserted = 0;
    try {
      const html = await fetchText(googlePlayDetailUrl(app.packageId, { language: app.language, country: app.country }), { proxyUrl });
      const reviewRawEntryCount = countGooglePlayDetailRawReviews(html);
      const reviews = parseGooglePlayDetailReviews(html, { app, keyword: app.keyword, maxReviews: maxReviewsPerApp });
      for (const review of reviews) {
        if (!isAfterSince(review.publishedAt, since)) continue;
        const matchedKeyword = normalizedKeywords.find(keyword => reviewMatchesKeyword(review, keyword)) || app.keyword || normalizedKeywords[0];
        inserted += insertGooglePlayReview({
          ...review,
          reviewRawEntryCount,
          matchedKeyword,
        }, { keyword: matchedKeyword, domainControls, contentControls, seenReviewKeys });
      }
    } catch (err) {
      failures.push({ target: `google-play-reviews:${app.language}:${app.country}:${app.packageId}`, message: formatSourceError(err, proxyUrl) });
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
  normalizeLanguages,
  normalizePackageIds,
  normalizeGooglePlayDirectUrls,
  googlePlaySearchUrl,
  googlePlayDetailUrl,
  countGooglePlaySearchRawApps,
  countGooglePlayDetailRawReviews,
  parseGooglePlaySearchApps,
  parseGooglePlayDetailReviews,
  normalizeGooglePlayKeywordText,
  googlePlayValueMatchesKeyword,
  reviewMatchesKeyword,
  googlePlayReviewKeywordMatchSource,
  googlePlayReviewKeywordDiagnostics,
  googlePlayReviewDedupeKey,
  googlePlayReviewExperienceSignals,
};
