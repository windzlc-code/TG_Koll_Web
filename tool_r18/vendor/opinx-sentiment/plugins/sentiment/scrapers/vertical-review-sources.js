import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { enrichSearchResultSummary } from "./content-summary.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; OpinXCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_TARGET = 4;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 12;
const DEFAULT_MAX_PAGES_PER_TARGET = 3;

export const VERTICAL_REVIEW_TARGETS = [
  {
    key: "chromeWebStore",
    name: "Chrome Web Store",
    siteQuery: "site:chromewebstore.google.com/detail",
    hostPattern: /(^|\.)chromewebstore\.google\.com$/i,
    tags: ["browser-extension", "review", "rating", "product"],
    profiles: ["global", "extension", "app", "review"],
    tier: "app-marketplace",
  },
  {
    key: "productHunt",
    name: "Product Hunt",
    siteQuery: "site:producthunt.com/products",
    hostPattern: /(^|\.)producthunt\.com$/i,
    tags: ["product-community", "launch", "review", "comment"],
    profiles: ["global", "startup", "product", "community"],
    tier: "product-community",
  },
  {
    key: "steam",
    name: "Steam Reviews",
    siteQuery: "site:store.steampowered.com/app",
    hostPattern: /(^|\.)store\.steampowered\.com$/i,
    tags: ["game", "software", "review", "rating"],
    profiles: ["global", "game", "software", "review"],
    tier: "software-marketplace",
  },
  {
    key: "g2",
    name: "G2",
    siteQuery: "site:g2.com/products",
    hostPattern: /(^|\.)g2\.com$/i,
    tags: ["saas", "b2b", "review", "rating"],
    profiles: ["global", "saas", "b2b", "review"],
    tier: "b2b-review",
  },
  {
    key: "capterra",
    name: "Capterra",
    siteQuery: "site:capterra.com/p",
    hostPattern: /(^|\.)capterra\.com$/i,
    tags: ["saas", "software", "review", "rating"],
    profiles: ["global", "saas", "software", "review"],
    tier: "b2b-review",
  },
  {
    key: "trustRadius",
    name: "TrustRadius",
    siteQuery: "site:trustradius.com/products",
    hostPattern: /(^|\.)trustradius\.com$/i,
    tags: ["saas", "b2b", "review", "rating"],
    profiles: ["global", "saas", "b2b", "review"],
    tier: "b2b-review",
  },
  {
    key: "microsoftStore",
    name: "Microsoft Store",
    siteQuery: "site:apps.microsoft.com/detail",
    hostPattern: /(^|\.)apps\.microsoft\.com$/i,
    tags: ["windows", "app", "review", "rating"],
    profiles: ["global", "windows", "app", "review"],
    tier: "app-marketplace",
  },
  {
    key: "getApp",
    name: "GetApp",
    siteQuery: "site:getapp.com review",
    hostPattern: /(^|\.)getapp\.com$/i,
    tags: ["saas", "software", "review", "rating"],
    profiles: ["global", "saas", "software", "b2b", "review"],
    tier: "b2b-review",
  },
  {
    key: "softwareAdvice",
    name: "Software Advice",
    siteQuery: "site:softwareadvice.com reviews",
    hostPattern: /(^|\.)softwareadvice\.com$/i,
    tags: ["saas", "software", "review", "rating"],
    profiles: ["global", "saas", "software", "b2b", "review"],
    tier: "b2b-review",
  },
  {
    key: "sourceForge",
    name: "SourceForge Software Reviews",
    siteQuery: "site:sourceforge.net/software/product",
    hostPattern: /(^|\.)sourceforge\.net$/i,
    tags: ["software", "open-source", "review", "rating"],
    profiles: ["global", "software", "open-source", "developer", "review"],
    tier: "software-marketplace",
  },
  {
    key: "alternativeTo",
    name: "AlternativeTo",
    siteQuery: "site:alternativeto.net/software",
    hostPattern: /(^|\.)alternativeto\.net$/i,
    tags: ["software", "alternative", "review", "community"],
    profiles: ["global", "software", "community", "review"],
    tier: "product-community",
  },
  {
    key: "appSumo",
    name: "AppSumo Products",
    siteQuery: "site:appsumo.com/products",
    hostPattern: /(^|\.)appsumo\.com$/i,
    tags: ["saas", "startup", "review", "deal", "comment"],
    profiles: ["global", "saas", "startup", "product", "review"],
    tier: "product-community",
  },
];

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(value, max = 1200) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeUrl(rawUrl) {
  const decoded = decodeHtml(rawUrl || "");
  try {
    const url = new URL(decoded);
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return decoded;
  }
}

function normalizeVerticalReviewDedupeUrl(rawUrl = "") {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const embedded = url.searchParams.get("url") || url.searchParams.get("u") || url.searchParams.get("target");
    if (embedded && /^https?:\/\//i.test(embedded)) return normalizeVerticalReviewDedupeUrl(embedded);
    url.hash = "";
    for (const key of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "ocid",
      "cid",
      "ref",
      "ref_src",
      "source",
      "mc_cid",
      "mc_eid",
    ]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^m\./, "");
    url.pathname = url.pathname.replace(/\/+$/g, "") || "/";
    return url.toString();
  } catch {
    return String(normalized || "").toLowerCase();
  }
}

function verticalReviewDedupeKey(item = {}) {
  return normalizeVerticalReviewDedupeUrl(item?.url || "");
}

function countDuckDuckGoRawResults(html = "") {
  return [...String(html || "").matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href=/gi)].length;
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerTarget || budget.max_items_per_target || budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_TARGET));
  const maxTargets = Math.round(Number(budget.maxTargetsPerKeyword || budget.max_targets_per_keyword || DEFAULT_MAX_TARGETS_PER_KEYWORD));
  const maxPages = Math.round(Number(budget.maxPagesPerTarget || budget.max_pages_per_target || budget.maxPagesPerKeyword || budget.max_pages_per_keyword || DEFAULT_MAX_PAGES_PER_TARGET));
  return {
    maxItemsPerTarget: Number.isFinite(maxItems) ? Math.max(1, Math.min(12, maxItems)) : DEFAULT_MAX_ITEMS_PER_TARGET,
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(VERTICAL_REVIEW_TARGETS.length, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
    maxPagesPerTarget: Number.isFinite(maxPages) ? Math.max(1, Math.min(5, maxPages)) : DEFAULT_MAX_PAGES_PER_TARGET,
  };
}

function normalizeProfileValues(values = []) {
  if (!values) return [];
  const raw = Array.isArray(values) ? values : String(values).split(/[,\s，、;；]+/);
  return raw.map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
}

function targetMatchesProfiles(target = {}, targetProfiles = []) {
  const profiles = normalizeProfileValues(targetProfiles);
  if (!profiles.length) return true;
  const values = new Set([
    ...(target.profiles || []),
    ...(target.tags || []),
    target.tier,
    target.key,
    target.name,
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  return profiles.some(profile => values.has(profile));
}

function normalizeTargets(targets = [], targetProfiles = []) {
  const configured = Array.isArray(targets) ? targets.map(item => String(item || "").trim()).filter(Boolean) : [];
  const candidates = VERTICAL_REVIEW_TARGETS.filter(target => targetMatchesProfiles(target, targetProfiles));
  if (!configured.length) return candidates.length ? candidates : VERTICAL_REVIEW_TARGETS;
  const wanted = new Set(configured.map(item => item.toLowerCase()));
  const selected = candidates.filter(target => wanted.has(target.key.toLowerCase()) || wanted.has(target.name.toLowerCase()));
  return selected.length ? selected : (candidates.length ? candidates : VERTICAL_REVIEW_TARGETS);
}

function normalizeDirectUrls(directUrls = []) {
  const raw = Array.isArray(directUrls)
    ? directUrls
    : typeof directUrls === "string"
      ? directUrls.split(/[\n,，]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const normalized = normalizeUrl(value);
    const dedupe = normalizeVerticalReviewDedupeUrl(normalized);
    if (!normalized || !dedupe || seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(normalized);
  }
  return out;
}

function hostMatches(url, pattern) {
  try {
    return pattern.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isConcreteVerticalReviewUrl(url = "", target = {}) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (!hostMatches(url, target.hostPattern)) return false;
    if (target.key === "chromeWebStore") return path.includes("/detail/");
    if (target.key === "productHunt") return path.includes("/products/") || path.includes("/posts/");
    if (target.key === "steam") return path.includes("/app/");
    if (target.key === "g2") return path.includes("/products/");
    if (target.key === "capterra") return path.includes("/p/") || path.includes("/reviews/");
    if (target.key === "trustRadius") return path.includes("/products/");
    if (target.key === "microsoftStore") return path.includes("/detail/");
    if (target.key === "getApp") return path.includes("/software/") || path.includes("/reviews/");
    if (target.key === "softwareAdvice") return path.includes("/reviews") || path.split("/").filter(Boolean).length >= 2;
    if (target.key === "sourceForge") return path.includes("/software/product/");
    if (target.key === "alternativeTo") return path.includes("/software/");
    if (target.key === "appSumo") return path.includes("/products/");
    return true;
  } catch {
    return false;
  }
}

function directVerticalReviewTargets(directUrls = [], selectedTargets = []) {
  const targets = Array.isArray(selectedTargets) && selectedTargets.length ? selectedTargets : VERTICAL_REVIEW_TARGETS;
  const out = [];
  const seen = new Set();
  for (const url of normalizeDirectUrls(directUrls)) {
    for (const target of targets) {
      if (!isConcreteVerticalReviewUrl(url, target)) continue;
      const dedupe = `${target.key}|${normalizeVerticalReviewDedupeUrl(url)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ url, target });
      break;
    }
  }
  return out;
}

function directVerticalReviewItem(url = "", keyword = "", target = {}) {
  const cleanedUrl = normalizeUrl(url);
  if (!cleanedUrl || !isConcreteVerticalReviewUrl(cleanedUrl, target)) return null;
  let title = `${keyword || ""} ${target.name || "vertical review"}`.replace(/\s+/g, " ").trim();
  try {
    const parsed = new URL(cleanedUrl);
    const slug = decodeURIComponent(parsed.pathname || "")
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join(" ")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (slug) title = `${keyword || ""} ${target.name || ""} ${slug}`.replace(/\s+/g, " ").trim();
  } catch {
    // Keep fallback title.
  }
  return {
    url: cleanedUrl,
    title,
    content: "",
    author: target.name,
    publishedAt: new Date().toISOString(),
    targetKey: target.key,
    targetName: target.name,
    targetTags: target.tags,
    directUrl: true,
    matchedKeyword: keyword,
    searchPage: 0,
    searchRawResultCount: 1,
  };
}

function normalizeVerticalReviewKeywordText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function verticalReviewKeywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 160);
  const compact = normalizeVerticalReviewKeywordText(raw);
  const parts = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return [...new Set([raw, compact, ...parts]
    .filter(Boolean)
    .map(part => String(part).toLowerCase()))]
    .slice(0, 12);
}

function verticalReviewValueMatchesKeyword(value = "", keyword = "") {
  const lower = cleanText(value, 1600).toLowerCase();
  const compact = normalizeVerticalReviewKeywordText(value);
  return verticalReviewKeywordNeedles(keyword).some((needle) => {
    const normalizedNeedle = normalizeVerticalReviewKeywordText(needle);
    return needle.length >= 2 && (
      lower.includes(needle)
      || (normalizedNeedle.length >= 2 && compact.includes(normalizedNeedle))
    );
  });
}

function parseVerticalReviewSearchResults(html, keyword, target, limit = DEFAULT_MAX_ITEMS_PER_TARGET) {
  const source = String(html || "");
  const results = [];
  const blockRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi;
  let match;
  while ((match = blockRegex.exec(source)) !== null) {
    const url = normalizeUrl(match[1]);
    const title = cleanText(match[2], 240);
    const content = cleanText((match[3].match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || match[3].match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || [])[1] || "", 1000);
    if (!url || !title) continue;
    if (!hostMatches(url, target.hostPattern)) continue;
    if (!verticalReviewValueMatchesKeyword(`${title} ${content}`, keyword)) continue;
    results.push({
      url,
      title,
      content,
      author: target.name,
      publishedAt: new Date().toISOString(),
      targetKey: target.key,
      targetName: target.name,
      targetTags: target.tags,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function verticalReviewKeywordMatchSource(item = {}, keyword = "", target = {}) {
  if (!verticalReviewKeywordNeedles(keyword).length) return "";
  if (verticalReviewValueMatchesKeyword(item.title, keyword)) return "title";
  if (verticalReviewValueMatchesKeyword(item.content, keyword)) return "snippet";
  if (verticalReviewValueMatchesKeyword(item.url, keyword)) return "url";
  const targetText = [
    target.name,
    target.key,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  if (verticalReviewValueMatchesKeyword(targetText, keyword)) return "target_metadata";
  return "search_query";
}

function verticalReviewTermMatches(text = "", terms = []) {
  const source = normalizeVerticalReviewKeywordText(text);
  return terms.filter(term => {
    const needle = normalizeVerticalReviewKeywordText(term);
    return needle && source.includes(needle);
  });
}

function verticalProductRiskSignals({ item = {}, target = {}, content = "", metrics = {} } = {}) {
  const metricText = Object.values(metrics)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => cleanText(value, 400))
    .filter(Boolean)
    .join(" ");
  const targetText = [
    target.name,
    target.key,
    target.tier,
    ...(Array.isArray(target.tags) ? target.tags : []),
    ...(Array.isArray(target.profiles) ? target.profiles : []),
  ].join(" ");
  const text = cleanText(`${item.title || ""} ${item.content || ""} ${content || ""} ${targetText} ${metricText}`, 7000).toLowerCase();
  const reasons = [];
  let score = /b2b-review|software-marketplace|app-marketplace|product-community/i.test(String(target.tier || "")) ? 14 : 10;
  const out = {};
  const evidenceTerms = verticalReviewTermMatches(text, [
    "screenshot", "screen recording", "proof", "logs", "error log", "ticket", "case number", "invoice", "receipt", "timeline", "documents",
    "截圖", "截图", "錄屏", "录屏", "證據", "证据", "日誌", "日志", "工單", "工单", "案件編號", "案件编号", "發票", "发票", "時間線", "时间线",
  ]);
  const responseTerms = verticalReviewTermMatches(text, [
    "vendor response", "company response", "official response", "support replied", "changelog", "roadmap", "resolved", "unresolved", "workaround", "apology",
    "廠商回應", "厂商回应", "官方回應", "官方回应", "客服回應", "客服回应", "已解決", "已解决", "未解決", "未解决", "替代方案", "道歉",
  ]);
  const churnTerms = verticalReviewTermMatches(text, [
    "switched to", "migrated to", "cancelled", "canceled", "churn", "left for", "replaced with", "alternative", "competitor",
    "轉用", "转用", "換到", "换到", "取消訂閱", "取消订阅", "流失", "替代", "競品", "竞品",
  ]);
  const versionTerms = verticalReviewTermMatches(text, [
    "after update", "latest release", "new version", "regression", "release", "changelog", "version", "upgrade",
    "更新後", "更新后", "新版本", "新版", "升級後", "升级后", "版本", "發版", "发版", "退步",
  ]);
  const spreadTerms = verticalReviewTermMatches(text, [
    "launch backlash", "product hunt comments", "reddit", "hacker news", "twitter", "x post", "linkedin", "community thread", "viral",
    "上線翻車", "上线翻车", "社群討論", "社群讨论", "轉發", "转发", "瘋傳", "疯传", "社媒", "論壇", "论坛",
  ]);
  const productImpactTerms = verticalReviewTermMatches(text, [
    "production outage", "downtime", "data loss", "blocked workflow", "cannot login", "lost customers", "churn", "refund", "cancelled", "security", "privacy", "data breach", "regression",
    "生產事故", "生产事故", "停機", "停机", "資料遺失", "数据丢失", "流程中斷", "流程中断", "無法登入", "无法登录", "客戶流失", "客户流失", "退款", "取消訂閱", "取消订阅", "安全", "隱私", "隐私", "資料外洩", "数据泄露", "退步",
  ]);
  const vendorActionTerms = verticalReviewTermMatches(text, [
    "vendor response", "company response", "official response", "support replied", "fix released", "patch", "rollback", "workaround", "resolved", "unresolved", "roadmap", "changelog", "refund issued",
    "廠商回應", "厂商回应", "官方回應", "官方回应", "客服回應", "客服回应", "已修復", "已修复", "補丁", "补丁", "回滾", "回滚", "替代方案", "已解決", "已解决", "未解決", "未解决", "路線圖", "路线图", "更新日誌", "更新日志",
  ]);
  const addSignal = (field, reason, condition, points) => {
    if (!condition) return;
    out[field] = true;
    reasons.push(reason);
    score += points;
  };

  addSignal("vertical_product_support_signal", "support or response concern", /support|customer service|help desk|response time|no response|客服|支援|支持|售後|售后|未回覆|未回复/i.test(text), 12);
  addSignal("vertical_product_onboarding_signal", "onboarding or usability concern", /onboarding|setup|migration|implementation|hard to use|confusing|learning curve|導入|导入|上手|配置|設定|设置|難用|难用/i.test(text), 10);
  addSignal("vertical_product_reliability_signal", "reliability, bug, or outage concern", /bug|broken|crash|unstable|downtime|outage|not working|error|reliability|錯誤|错误|故障|不穩|不稳|不能用|當機|当机/i.test(text), 14);
  addSignal("vertical_product_integration_signal", "integration or API concern", /integration|api|webhook|sync|import|export|connector|plugin|整合|集成|同步|匯入|导入|接口/i.test(text), 10);
  addSignal("vertical_product_pricing_signal", "pricing, billing, or plan concern", /pricing|price|expensive|billing|subscription|plan|renewal|refund|價格|价格|昂貴|昂贵|訂閱|订阅|扣款|退款/i.test(text), 12);
  addSignal("vertical_product_security_privacy_signal", "security or privacy concern", /security|privacy|data leak|data breach|permission|tracking|安全|隱私|隐私|資料外洩|数据泄露|權限|权限/i.test(text), 16);
  addSignal("vertical_product_low_rating_signal", "low rating or negative review language", /low rating|bad rating|negative review|one star|1 star|差評|差评|低評分|低评分|一星/i.test(text), 10);
  addSignal("vertical_product_competitor_alternative_signal", "competitor or switching narrative", /alternative|competitor|switching|switched to|migrated to|replacement|替代|競品|竞品|換到|换到|轉用|转用/i.test(text), 8);
  addSignal("vertical_product_marketplace_signal", "vertical product review source", /saas|software|app|extension|product|community|review|rating|產品|产品|軟體|软件/i.test(targetText), 6);
  addSignal("vertical_product_evidence_language_signal", "review contains evidence language", evidenceTerms.length > 0, 12);
  addSignal("vertical_product_response_language_signal", "vendor response or resolution language", responseTerms.length > 0, 10);
  addSignal("vertical_product_churn_language_signal", "customer churn or competitor switching language", churnTerms.length > 0, 12);
  addSignal("vertical_product_version_regression_signal", "release or version regression language", versionTerms.length > 0, 12);
  addSignal("vertical_product_spread_language_signal", "product community spread language", spreadTerms.length > 0, 10);
  addSignal("vertical_product_impact_language_signal", "product impact involving outage, data loss, blocked workflow, churn, refund, security, or regression", productImpactTerms.length > 0, 10);
  addSignal("vertical_product_vendor_action_signal", "vendor action involving fix, patch, rollback, workaround, roadmap, refund, or official response", vendorActionTerms.length > 0, 8);

  const semanticSignals = [
    out.vertical_product_support_signal,
    out.vertical_product_onboarding_signal,
    out.vertical_product_reliability_signal,
    out.vertical_product_integration_signal,
    out.vertical_product_pricing_signal,
    out.vertical_product_security_privacy_signal,
    out.vertical_product_low_rating_signal,
    out.vertical_product_competitor_alternative_signal,
    out.vertical_product_marketplace_signal,
    out.vertical_product_evidence_language_signal,
    out.vertical_product_response_language_signal,
    out.vertical_product_churn_language_signal,
    out.vertical_product_version_regression_signal,
    out.vertical_product_spread_language_signal,
    out.vertical_product_impact_language_signal,
    out.vertical_product_vendor_action_signal,
  ].filter(Boolean).length;
  addSignal(
    "vertical_product_complete_product_risk_narrative_signal",
    "complete vertical product risk narrative with marketplace context, product impact, evidence, vendor action or response, and churn, regression, or spread context",
    semanticSignals >= 8
      && out.vertical_product_marketplace_signal
      && out.vertical_product_impact_language_signal
      && out.vertical_product_evidence_language_signal
      && (out.vertical_product_response_language_signal || out.vertical_product_vendor_action_signal)
      && (out.vertical_product_churn_language_signal || out.vertical_product_version_regression_signal || out.vertical_product_spread_language_signal),
    12,
  );

  const signalFields = Object.keys(out).filter(key => key.endsWith("_signal"));
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...out,
    vertical_product_risk_score: boundedScore,
    vertical_product_risk_bucket: boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low",
    vertical_product_signal_count: signalFields.length,
    vertical_product_semantic_signal_count: semanticSignals,
    vertical_product_signal_reasons: [...new Set(reasons)].slice(0, 16),
    vertical_product_evidence_terms: evidenceTerms,
    vertical_product_response_terms: responseTerms,
    vertical_product_churn_terms: churnTerms,
    vertical_product_version_regression_terms: versionTerms,
    vertical_product_spread_terms: spreadTerms,
    vertical_product_impact_terms: productImpactTerms,
    vertical_product_vendor_action_terms: vendorActionTerms,
  };
}

function evidenceWithVerticalMetadata(evidence = {}, item = {}, target = {}, failoverAttribution = [], content = "") {
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const evidenceMetrics = evidence?.metrics || {};
  return {
    ...(evidence || {}),
    source_key: "verticalReviewSources",
    evidence_type: "vertical_review_source_result",
    metrics: {
      ...evidenceMetrics,
      ...verticalProductRiskSignals({ item, target, content, metrics: evidenceMetrics }),
      source: "vertical_review_source_search",
      vertical_source: target.name || item.targetName || "",
      vertical_source_key: target.key || item.targetKey || "",
      site_tags: Array.isArray(target.tags) ? target.tags : item.targetTags || [],
      target_profiles: Array.isArray(target.profiles) ? target.profiles : [],
      source_weight_tier: target.tier || "",
      source_family: "review",
      vertical_review_canonical_dedupe_url: verticalReviewDedupeKey(item),
      vertical_review_search_scan_dedupe_key: verticalReviewDedupeKey(item),
      vertical_review_search_page: Math.max(1, Number(item.searchPage) || 1),
      vertical_review_search_raw_result_count: Math.max(0, Number(item.searchRawResultCount) || 0),
      vertical_review_matched_keyword: item.matchedKeyword || "",
      vertical_review_keyword_match_source: verticalReviewKeywordMatchSource(item, item.matchedKeyword || "", target),
      vertical_review_direct_url: item.directUrl ? item.url : "",
      vertical_review_direct_url_recovery: Boolean(item.directUrl),
      vertical_review_collection_mode: item.directUrl ? "direct-url" : "search",
      ...(attribution.length ? {
        failover_attribution: attribution,
        failover_from_sources: [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))],
      } : {}),
    },
  };
}

async function insertVerticalItems(items, { keyword, proxyUrl, enrich, target, seenItemUrls = null, domainControls = {}, contentControls = {}, failoverAttribution = [] }) {
  let inserted = 0;
  for (const item of items) {
    const dedupeKey = verticalReviewDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const fallback = item.content || "";
    const enriched = enrich
      ? await enrichSearchResultSummary(item, { proxyUrl })
      : { content: fallback, ai_summary: fallback, enriched: false };
    const content = enriched.content || fallback;
    const sentiment = analyzeSentiment(`${item.title} ${content}`);
    const result = insertSentimentItem({
      platform: "vertical_review_sources",
      url: item.url,
      title: item.title,
      content,
      author: enriched.author || item.author,
      sentiment,
      risk_level: assessRiskLevel({ title: item.title, content, sentiment }),
      keyword,
      keywords: [keyword, ...(Array.isArray(target.tags) ? target.tags : [])].filter(Boolean),
      published_at: enriched.published_at || item.publishedAt,
      ai_summary: enriched.ai_summary,
      raw_html: enriched.raw_html || "",
      evidence: evidenceWithVerticalMetadata(enriched.evidence || {}, item, target, failoverAttribution, content),
      visual_assets: enriched.visual_assets || [],
      source_type: "scraper",
      domainControls,
      contentControls,
      failoverAttribution,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapeVerticalReviewSources(keywords, { proxyUrl = "", enrich = true, budget = {}, targets = [], targetProfiles = [], domainControls = {}, contentControls = {}, failoverAttribution = [], directUrls = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  const normalizedDirectUrls = normalizeDirectUrls(directUrls);
  if (!normalizedKeywords.length && !normalizedDirectUrls.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const selectedTargets = normalizeTargets(targets, targetProfiles).slice(0, normalizedBudget.maxTargetsPerKeyword);
  const seenItemUrls = new Set();
  let directInserted = 0;
  const directFailures = [];
  const directKeyword = normalizedKeywords[0] || "vertical-review-direct-url";
  for (const { url, target } of directVerticalReviewTargets(normalizedDirectUrls, selectedTargets)) {
    try {
      const item = directVerticalReviewItem(url, directKeyword, target);
      if (!item) continue;
      directInserted += await insertVerticalItems([item], {
        keyword: directKeyword,
        proxyUrl,
        enrich: true,
        target,
        seenItemUrls,
        domainControls,
        contentControls,
        failoverAttribution,
      });
    } catch (err) {
      directFailures.push({ keyword: directKeyword, target: url, message: formatSourceError(err, proxyUrl) });
    }
  }
  if (!normalizedKeywords.length) return scraperResult(directInserted, directFailures);
  const tasks = normalizedKeywords.flatMap(keyword => selectedTargets.map(target => ({ keyword, target })));

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, async ({ keyword, target }) => {
    let inserted = 0;
    const failures = [];
    const query = `${keyword} product review rating customer feedback ${target.siteQuery}`;
    try {
      const found = [];
      const seenUrls = new Set();
      for (let page = 0; page < normalizedBudget.maxPagesPerTarget && found.length < normalizedBudget.maxItemsPerTarget; page += 1) {
        const params = new URLSearchParams({ q: query, kl: "us-en" });
        if (page > 0) params.set("s", String(page * 30));
        const url = `https://duckduckgo.com/html/?${params.toString()}`;
        const res = await fetchPublicSource(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: target.name, page: page + 1, message: httpFailure(res) });
          break;
        }
        const html = await res.text();
        const rawCount = countDuckDuckGoRawResults(html);
        const items = parseVerticalReviewSearchResults(html, keyword, target, normalizedBudget.maxItemsPerTarget - found.length);
        let pageFound = 0;
        for (const item of items) {
          const dedupeKey = verticalReviewDedupeKey(item);
          if (!dedupeKey || seenUrls.has(dedupeKey)) continue;
          seenUrls.add(dedupeKey);
          found.push({ ...item, searchPage: page + 1, searchRawResultCount: rawCount, matchedKeyword: keyword });
          pageFound += 1;
          if (found.length >= normalizedBudget.maxItemsPerTarget) break;
        }
        if (!pageFound && !rawCount) break;
      }
      inserted += await insertVerticalItems(found, { keyword, proxyUrl, enrich, target, seenItemUrls, domainControls, contentControls, failoverAttribution });
    } catch (err) {
      const message = formatSourceError(err, proxyUrl);
      failures.push({ keyword, target: target.name, message });
      console.warn(`[CRM/VerticalReviewSources] 抓取失敗 keyword=${keyword} target=${target.name}: ${message}`);
    }
    return { inserted, failures };
  });

  return scraperResult(
    directInserted + results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    [...directFailures, ...results.flatMap(result => result?.failures || [])],
  );
}

export const __test__ = {
  normalizeBudget,
  normalizeTargets,
  normalizeDirectUrls,
  directVerticalReviewTargets,
  directVerticalReviewItem,
  isConcreteVerticalReviewUrl,
  normalizeProfileValues,
  targetMatchesProfiles,
  normalizeVerticalReviewDedupeUrl,
  verticalReviewDedupeKey,
  countDuckDuckGoRawResults,
  parseVerticalReviewSearchResults,
  normalizeVerticalReviewKeywordText,
  verticalReviewValueMatchesKeyword,
  verticalReviewKeywordMatchSource,
  verticalProductRiskSignals,
  VERTICAL_REVIEW_TARGETS,
};
