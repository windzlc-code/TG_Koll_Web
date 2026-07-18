import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";
import { isTelegramPublicNetworkUrl, scraperResult } from "./http.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MAX_TEXT = 1200;
const DETAIL_MAX_TEXT = 4000;
const MAX_OUTBOUND_LINKS = 12;
const COOKIE_EXPIRING_SOON_SECONDS = 7 * 24 * 60 * 60;
const STALE_SESSION_DAYS = 14;
let playwrightLoader = () => import("playwright");

function stripText(value = "", max = MAX_TEXT) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function absoluteUrl(href = "", baseUrl = "") {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function decodeRedirectUrl(url = "") {
  if (!url) return "";
  try {
    const current = new URL(url);
    const host = current.hostname.replace(/^www\./, "");
    if (host.startsWith("google.") && current.pathname === "/url") {
      return absoluteUrl(current.searchParams.get("q") || current.searchParams.get("url") || "", url);
    }
    if (host === "duckduckgo.com" && current.pathname.startsWith("/l/")) {
      return absoluteUrl(current.searchParams.get("uddg") || "", url);
    }
    if (host.endsWith("bing.com")) {
      const target = current.searchParams.get("url") || current.searchParams.get("u");
      if (target) {
        const normalized = target.startsWith("a1")
          ? target.slice(2)
          : target;
        return absoluteUrl(normalized, url);
      }
    }
    if (host.endsWith("search.yahoo.com")) {
      return absoluteUrl(current.searchParams.get("RU") || current.searchParams.get("ru") || "", url);
    }
  } catch {
    return "";
  }
  return "";
}

function buildSearchUrl(template = "", keyword = "") {
  const encoded = encodeURIComponent(keyword);
  return String(template || "")
    .replace(/\{query\}/g, encoded)
    .replace(/\{keyword\}/g, encoded)
    .replace(/\{rawQuery\}/g, keyword);
}

function resolveSearchUrls(profile = {}, keyword = "") {
  const templates = [
    ...(Array.isArray(profile.urlTemplates || profile.url_templates) ? (profile.urlTemplates || profile.url_templates) : []),
    profile.urlTemplate || profile.url_template || "",
  ];
  return [...new Set(templates
    .map(template => buildSearchUrl(template, keyword))
    .filter(url => /^https?:\/\//i.test(url)))]
    .slice(0, 6);
}

function browserSearchEngineName(url = "") {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.startsWith("google.")) return "google";
    if (host.endsWith("bing.com")) return "bing";
    if (host === "duckduckgo.com") return "duckduckgo";
    if (host.endsWith("search.yahoo.com")) return "yahoo";
    return host || "browser";
  } catch {
    return "browser";
  }
}

function hostMatches(url = "", domain = "") {
  if (!domain) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const wanted = String(domain || "").replace(/^\.+/, "").replace(/^www\./, "");
    return host === wanted || host.endsWith(`.${wanted}`);
  } catch {
    return false;
  }
}

function profileHostMatches(url = "", profile = {}) {
  const domains = [
    profile.domain,
    ...(Array.isArray(profile.matchDomains || profile.match_domains) ? (profile.matchDomains || profile.match_domains) : []),
  ].map(item => String(item || "").trim()).filter(Boolean);
  if (!domains.length) return true;
  return domains.some(domain => hostMatches(url, domain));
}

function linkMatches(url = "", pattern = "") {
  if (!pattern) return true;
  const patterns = Array.isArray(pattern) ? pattern : String(pattern).split(/[,\n]+/);
  return patterns.map(item => item.trim()).filter(Boolean).some(item => url.includes(item));
}

function normalizeCookie(cookie = {}, domain = "") {
  if (!cookie?.name || !cookie?.value) return null;
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0 && expires <= Date.now() / 1000) return null;
  const out = {
    name: String(cookie.name),
    value: String(cookie.value),
    path: cookie.path || "/",
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.domain || domain) out.domain = cookie.domain || `.${String(domain).replace(/^\.+/, "")}`;
  if (cookie.expires && Number.isFinite(expires)) out.expires = expires;
  if (["Strict", "Lax", "None"].includes(cookie.sameSite)) out.sameSite = cookie.sameSite;
  return out;
}

function browserFallbackProfileCookieState(profile = {}, now = new Date()) {
  const rawCookies = Array.isArray(profile.cookies) ? profile.cookies : [];
  const nowSeconds = now.getTime() / 1000;
  const activeCookies = [];
  let expiredCookieCount = 0;
  let expiringSoonCookieCount = 0;
  let sessionCookieCount = 0;
  let persistentCookieCount = 0;
  const expiredCookieNames = [];
  const expiringSoonCookieNames = [];
  for (const cookie of rawCookies) {
    const expires = Number(cookie?.expires);
    if (Number.isFinite(expires) && expires > 0 && expires <= nowSeconds) {
      expiredCookieCount += 1;
      if (cookie?.name && expiredCookieNames.length < 20) expiredCookieNames.push(cookie.name);
      continue;
    }
    const normalized = normalizeCookie(cookie, profile.domain);
    if (!normalized) continue;
    activeCookies.push(normalized);
    if (!Number.isFinite(expires) || expires <= 0) {
      sessionCookieCount += 1;
    } else {
      persistentCookieCount += 1;
      if (expires <= nowSeconds + COOKIE_EXPIRING_SOON_SECONDS) {
        expiringSoonCookieCount += 1;
        if (cookie?.name && expiringSoonCookieNames.length < 20) expiringSoonCookieNames.push(cookie.name);
      }
    }
  }
  const lastAuthorizedAt = profile.lastAuthorizedAt || profile.last_authorized_at || "";
  const lastAuthorizedTime = lastAuthorizedAt ? new Date(lastAuthorizedAt).getTime() : NaN;
  const lastAuthorizedAgeDays = Number.isFinite(lastAuthorizedTime)
    ? Math.max(0, Math.round(((now.getTime() - lastAuthorizedTime) / (24 * 60 * 60 * 1000)) * 10) / 10)
    : null;
  const statusReasons = [];
  let authHealth = rawCookies.length ? "healthy" : "public";
  let recommendedAction = rawCookies.length ? "keep" : "public-browser-search";
  if (rawCookies.length && !activeCookies.length) {
    authHealth = "expired";
    recommendedAction = "reauthorize-profile";
    statusReasons.push("all-cookies-expired");
  } else if (expiredCookieCount > 0) {
    authHealth = "degraded";
    recommendedAction = "refresh-profile-cookies";
    statusReasons.push("partial-expired-cookies");
  } else if (expiringSoonCookieCount > 0) {
    authHealth = "watch";
    recommendedAction = "refresh-before-expiry";
    statusReasons.push("cookies-expiring-soon");
  } else if (rawCookies.length && persistentCookieCount === 0 && sessionCookieCount > 0 && lastAuthorizedAgeDays !== null && lastAuthorizedAgeDays > STALE_SESSION_DAYS) {
    authHealth = "watch";
    recommendedAction = "reauthorize-session-profile";
    statusReasons.push("stale-session-cookies");
  }
  return {
    key: profile.key || "",
    sourceKey: profile.sourceKey || profile.source_key || "",
    label: profile.label || "",
    domain: profile.domain || "",
    cookieCount: rawCookies.length,
    validCookieCount: activeCookies.length,
    expiredCookieCount,
    expiringSoonCookieCount,
    sessionCookieCount,
    persistentCookieCount,
    activeCookies,
    authHealth,
    recommendedAction,
    statusReasons,
    lastAuthorizedAgeDays,
    expiredCookieNames: [...new Set(expiredCookieNames)],
    expiringSoonCookieNames: [...new Set(expiringSoonCookieNames)],
    shouldSkip: rawCookies.length > 0 && activeCookies.length === 0,
  };
}

function buildBrowserFallbackDiagnostics(states = [], { inserted = 0, failures = [] } = {}) {
  const rows = Array.isArray(states) ? states : [];
  const summary = {
    configured_profile_count: rows.length,
    runnable_profile_count: rows.filter(state => !state.shouldSkip).length,
    skipped_profile_count: rows.filter(state => state.shouldSkip).length,
    cookie_profile_count: rows.filter(state => state.cookieCount > 0).length,
    public_profile_count: rows.filter(state => state.cookieCount === 0).length,
    expired_profile_count: rows.filter(state => state.authHealth === "expired").length,
    degraded_profile_count: rows.filter(state => state.authHealth === "degraded").length,
    watch_profile_count: rows.filter(state => state.authHealth === "watch").length,
    inserted_count: Number(inserted || 0),
    failure_count: Array.isArray(failures) ? failures.length : 0,
  };
  return {
    summary,
    profiles: rows.map(state => ({
      key: state.key,
      source_key: state.sourceKey,
      label: state.label,
      domain: state.domain,
      auth_health: state.authHealth,
      recommended_action: state.recommendedAction,
      status_reasons: state.statusReasons,
      cookie_count: state.cookieCount,
      valid_cookie_count: state.validCookieCount,
      expired_cookie_count: state.expiredCookieCount,
      expiring_soon_cookie_count: state.expiringSoonCookieCount,
      session_cookie_count: state.sessionCookieCount,
      persistent_cookie_count: state.persistentCookieCount,
      last_authorized_age_days: state.lastAuthorizedAgeDays,
      skipped: state.shouldSkip,
    })),
  };
}

function keywordMatch(text = "", keyword = "") {
  const haystack = stripText(text, 3000).toLowerCase();
  const parts = String(keyword || "")
    .toLowerCase()
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2);
  return !parts.length || parts.some(part => haystack.includes(part));
}

async function loadPlaywright() {
  try {
    return await playwrightLoader();
  } catch (error) {
    throw new Error(`Playwright 浏览器运行时未安装：${error?.message || error}`);
  }
}

function firstMeaningful(...values) {
  for (const value of values) {
    const text = stripText(value, DETAIL_MAX_TEXT);
    if (text) return text;
  }
  return "";
}

function normalizeDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function classifyOutboundLink({ url = "", pageUrl = "", title = "", context = "" } = {}) {
  const linkDomain = normalizeDomain(url);
  const pageDomain = normalizeDomain(pageUrl);
  const sameHost = Boolean(linkDomain && pageDomain && linkDomain === pageDomain);
  const joined = `${title} ${context} ${url}`.toLowerCase();
  if (sameHost) return { kind: "internal-reference", sameHost: true };
  if (/\b(threads\.net|instagram\.com|facebook\.com|x\.com|twitter\.com|youtube\.com|reddit\.com|dcard\.tw|ptt\.cc|weibo\.com|bluesky|mastodon)\b/.test(linkDomain)
    || /社群|轉傳|讨论|討論|thread|tweet|post|video|channel|forum|reddit|threads|instagram|facebook|x\//i.test(joined)) {
    return { kind: "social-amplification", sameHost: false };
  }
  if (/\.(gov|gov\.tw|mil|edu)$/i.test(linkDomain)
    || /official|statement|press|newsroom|regulator|regulatory|authority|政府|主管機關|主管机关|聲明|声明|公告|監管|监管/i.test(joined)) {
    return { kind: "official-reference", sameHost: false };
  }
  return { kind: "article-followup", sameHost: false };
}

function normalizeOutboundLinks(outboundLinks = [], pageUrl = "") {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(outboundLinks) ? outboundLinks : []) {
    const url = absoluteUrl(row?.url || row?.href || "", pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = stripText(row?.title || row?.label || row?.text || "", 220);
    const context = stripText(row?.context || row?.snippet || "", 360);
    const domain = normalizeDomain(url);
    const { kind, sameHost } = classifyOutboundLink({ url, pageUrl, title, context });
    out.push({
      url,
      title: title || domain || url,
      domain,
      kind,
      same_host: sameHost,
      reasons: [kind],
    });
    if (out.length >= MAX_OUTBOUND_LINKS) break;
  }
  return out;
}

function browserFallbackTermMatches(text = "", terms = [], limit = 12) {
  const haystack = stripText(text, 6000).toLowerCase();
  if (!haystack) return [];
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    if (!raw) continue;
    if (haystack.includes(raw.toLowerCase()) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function browserFallbackNarrativeSignals(item = {}) {
  const text = `${item.title || ""} ${item.content || ""} ${item.author || ""}`;
  const evidenceTerms = browserFallbackTermMatches(text, [
    "截圖", "截图", "錄影", "录像", "證據", "证据", "憑證", "凭证", "文件", "發票", "发票",
    "訂單", "订单", "時間線", "时间线", "調查", "调查", "爆料", "實測", "实测", "proof", "evidence", "timeline",
  ]);
  const impactTerms = browserFallbackTermMatches(text, [
    "退款", "拒退", "客服", "款項", "款项", "消費者", "消费者", "用戶", "用户", "受害", "損失", "损失",
    "風險", "风险", "詐騙", "诈骗", "炎上", "抵制", "refund", "customer support", "loss", "risk", "scam", "boycott",
  ]);
  const responseTerms = browserFallbackTermMatches(text, [
    "官方回應", "官方回应", "官方聲明", "官方声明", "公開回應", "公开回应", "客服回覆", "客服回复",
    "客服回應", "客服回应", "道歉", "致歉", "澄清", "說明", "说明", "承諾", "承诺", "official response", "statement", "apology",
  ]);
  const propagationTerms = browserFallbackTermMatches(text, [
    "擴散", "扩散", "延燒", "延烧", "發酵", "发酵", "熱議", "热议", "轉傳", "转传", "社群", "社群平台",
    "媒體報導", "媒体报道", "輿論", "舆论", "viral", "spreading", "trending", "media coverage",
  ]);
  const crisisTerms = browserFallbackTermMatches(text, [
    "投訴", "投诉", "客訴", "客诉", "退款", "拒退", "詐騙", "诈骗", "資安", "资安", "外洩", "泄露",
    "召回", "調查", "调查", "訴訟", "诉讼", "危機", "危机", "complaint", "refund", "scam", "breach", "crisis",
  ]);
  const timelineTerms = browserFallbackTermMatches(text, [
    "時間線", "时间线", "何時", "何时", "先後", "先后", "當日", "当日", "隔日", "隔日", "timeline", "sequence", "chronology",
  ]);
  const reasons = [];
  if (evidenceTerms.length) reasons.push("browser-fallback-evidence-language");
  if (impactTerms.length) reasons.push("browser-fallback-impact-language");
  if (responseTerms.length) reasons.push("browser-fallback-official-response-language");
  if (propagationTerms.length) reasons.push("browser-fallback-propagation-language");
  if (crisisTerms.length) reasons.push("browser-fallback-crisis-language");
  if (timelineTerms.length) reasons.push("browser-fallback-timeline-language");
  const semanticSignals = [
    evidenceTerms.length,
    impactTerms.length,
    responseTerms.length,
    propagationTerms.length,
    crisisTerms.length,
  ].filter(Boolean).length;
  const completeNarrative = evidenceTerms.length > 0
    && impactTerms.length > 0
    && responseTerms.length > 0
    && propagationTerms.length > 0
    && crisisTerms.length > 0
    && semanticSignals >= 5;
  if (completeNarrative) reasons.push("browser-fallback-complete-media-crisis-narrative");
  return {
    browser_detail_timeline_signal: timelineTerms.length ? 1 : 0,
    browser_detail_timeline_terms: timelineTerms,
    browser_media_evidence_signal: evidenceTerms.length ? 1 : 0,
    browser_media_impact_signal: impactTerms.length ? 1 : 0,
    browser_media_official_response_signal: responseTerms.length ? 1 : 0,
    browser_media_propagation_signal: propagationTerms.length ? 1 : 0,
    browser_media_crisis_signal: crisisTerms.length ? 1 : 0,
    browser_media_semantic_signal_count: semanticSignals,
    browser_media_complete_crisis_narrative_signal: completeNarrative ? 1 : 0,
    browser_media_evidence_terms: evidenceTerms,
    browser_media_impact_terms: impactTerms,
    browser_media_response_terms: responseTerms,
    browser_media_propagation_terms: propagationTerms,
    browser_media_crisis_terms: crisisTerms,
    browser_media_narrative_reasons: reasons,
  };
}

function normalizePageDetail(detail = {}, fallback = {}) {
  const title = firstMeaningful(detail.title, fallback.title);
  const content = firstMeaningful(detail.content, detail.description, fallback.content);
  const pageUrl = detail.url || fallback.url || "";
  const canonicalUrl = absoluteUrl(detail.canonicalUrl || "", pageUrl) || "";
  const imageUrl = absoluteUrl(detail.imageUrl || "", pageUrl) || "";
  const outboundLinks = normalizeOutboundLinks(detail.outboundLinks || detail.outlinks || [], canonicalUrl || pageUrl);
  return {
    title,
    content: content.slice(0, DETAIL_MAX_TEXT),
    author: firstMeaningful(detail.author, fallback.author),
    publishedAt: firstMeaningful(detail.publishedAt, fallback.publishedAt),
    canonicalUrl,
    imageUrl,
    outboundLinks,
    extractionStrategy: firstMeaningful(detail.extractionStrategy, "browser-article"),
  };
}

async function extractPageDetail(page, { fallback = {} } = {}) {
  const detail = await page.evaluate(() => {
    const clean = (value, max = 6000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
    const meta = (name, attr = "name") => {
      const node = document.querySelector(`meta[${attr}="${name}"]`);
      return clean(node?.getAttribute("content") || "", 1200);
    };
    const pickContentNode = () => (
      document.querySelector("article")
      || document.querySelector("main article")
      || document.querySelector("main")
      || document.querySelector("[role='main']")
      || document.querySelector(".article-content, .post-content, .entry-content, .story-body, .article-body")
      || document.body
    );
    const contentNode = pickContentNode();
    const content = clean(contentNode?.innerText || "", 6000);
    const baseUrl = window.location.href;
    const pageHost = (() => {
      try {
        return new URL(baseUrl).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();
    const title = clean(
      document.querySelector("h1")?.textContent
      || meta("og:title", "property")
      || document.title,
      240,
    );
    const description = clean(
      meta("description")
      || meta("og:description", "property")
      || content.slice(0, 300),
      1200,
    );
    return {
      title,
      description,
      content,
      author: clean(
        meta("author")
        || meta("article:author", "property")
        || document.querySelector("[rel='author']")?.textContent
        || document.querySelector(".author, .article-author, [itemprop='author']")?.textContent,
        160,
      ),
      publishedAt: clean(
        meta("article:published_time", "property")
        || meta("publish-date")
        || document.querySelector("time")?.getAttribute("datetime")
        || document.querySelector("time")?.textContent,
        120,
      ),
      canonicalUrl: clean(
        document.querySelector("link[rel='canonical']")?.getAttribute("href")
        || meta("og:url", "property"),
        1200,
      ),
      imageUrl: clean(
        meta("og:image", "property")
        || document.querySelector("article img, main img")?.getAttribute("src"),
        1200,
      ),
      outboundLinks: [...new Map((Array.from(contentNode?.querySelectorAll?.("a[href]") || [])
        .map((link) => {
          const href = clean(link.getAttribute("href") || "", 1200);
          const label = clean(link.textContent || link.getAttribute("title") || link.getAttribute("aria-label") || "", 240);
          if (!href) return null;
          let url = "";
          try {
            url = new URL(href, baseUrl).toString();
          } catch {
            return null;
          }
          let domain = "";
          try {
            domain = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            domain = "";
          }
          return [url, {
            url,
            title: label,
            domain,
            same_host: Boolean(pageHost && domain && domain === pageHost),
          }];
        })
        .filter(Boolean))).values()].slice(0, 20),
      extractionStrategy: contentNode?.tagName?.toLowerCase() === "article" ? "browser-article" : "browser-main",
    };
  });
  return normalizePageDetail(detail, fallback);
}

async function extractPageLinks(page, { baseUrl = "", profile = {}, keyword = "", maxItems = 8 } = {}) {
  const rows = await page.$$eval("a[href]", (links) => links.map((link) => {
    const title = (link.innerText || link.getAttribute("aria-label") || link.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const href = link.getAttribute("href") || "";
    const container = link.closest("article, ytd-video-renderer, ytd-rich-item-renderer, shreddit-post, div, li");
    const content = (container?.innerText || title || "").replace(/\s+/g, " ").trim();
    return { title, href, content };
  }).slice(0, 240));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const rawUrl = absoluteUrl(row.href, baseUrl);
    const url = decodeRedirectUrl(rawUrl) || rawUrl;
    if (!url || seen.has(url)) continue;
    if (!profileHostMatches(url, profile)) continue;
    if (!linkMatches(url, profile.linkPattern)) continue;
    const title = stripText(row.title || row.content, 220);
    const content = stripText(row.content || title, MAX_TEXT);
    if (!title || !keywordMatch(`${title} ${content} ${url}`, keyword)) continue;
    seen.add(url);
    out.push({ title, url, content });
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeProfiles(settings = {}, sourceConfig = {}) {
  const normalizeSourceKeyList = (value = []) => {
    if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
    if (typeof value === "string") return value.split(/[,\s，、;；]+/).map(item => item.trim()).filter(Boolean);
    return [];
  };
  const enabledKeys = new Set([
    ...normalizeSourceKeyList(settings.sourceKeys),
    ...normalizeSourceKeyList(settings.source_keys),
    ...normalizeSourceKeyList(sourceConfig.sourceKeys),
    ...normalizeSourceKeyList(sourceConfig.source_keys),
  ].map(item => String(item || "").trim()).filter(Boolean));
  const rawProfiles = Array.isArray(sourceConfig.profiles) && sourceConfig.profiles.length
    ? sourceConfig.profiles
    : Array.isArray(settings.profiles)
      ? settings.profiles
      : [];
  return rawProfiles
    .filter(profile => profile?.enabled !== false)
    .filter((profile) => {
      if (!enabledKeys.size) return true;
      const profileKeys = [
        profile.sourceKey,
        profile.source_key,
        profile.key,
        ...normalizeSourceKeyList(profile.sourceKeys),
        ...normalizeSourceKeyList(profile.source_keys),
      ].map(item => String(item || "").trim()).filter(Boolean);
      return profileKeys.some(key => enabledKeys.has(key));
    })
    .slice(0, Math.max(1, Math.min(30, Number(settings.maxProfilesPerKeyword || 3))));
}

export async function scrapeBrowserFallback(keywords, {
  browserSettings = {},
  sourceConfig = {},
  budget = {},
  domainControls = {},
  contentControls = {},
} = {}) {
  const settings = { ...browserSettings, ...sourceConfig };
  const maxKeywords = Math.max(1, Math.min(20, Number(settings.maxKeywords || settings.max_keywords || 4) || 4));
  const normalizedKeywords = (Array.isArray(keywords) ? keywords.map(item => stripText(item, 160)).filter(Boolean) : []).slice(0, maxKeywords);
  if (!normalizedKeywords.length) return scraperResult(0);
  if (settings.enabled === false) return scraperResult(0);
  const allProfiles = normalizeProfiles(browserSettings, sourceConfig);
  if (!allProfiles.length) return scraperResult(0, [{ target: "browserFallback", message: "未配置浏览器采集站点 Profile" }]);
  const maxItems = Math.max(1, Math.min(30, Number(settings.maxItemsPerKeyword || budget.maxItemsPerKeyword || 8) || 8));
  const timeoutMs = Math.max(5000, Math.min(90000, Number(settings.timeoutMs || 25000) || 25000));
  const waitMs = Math.max(0, Math.min(10000, Number(settings.waitMs || 1800) || 0));
  const captureResultPages = settings.captureResultPages !== false;
  const maxDetailPagesPerKeyword = Math.max(0, Math.min(10, Number(settings.maxDetailPagesPerKeyword || settings.max_detail_pages_per_keyword || 3) || 0));
  const deadlineAt = Date.now() + Math.max(10000, Math.min(42000, Number(settings.runDeadlineMs || settings.run_deadline_ms || 40000) || 40000));
  const failures = [];
  const profileCookieStates = new Map();
  const profileStates = [];
  const profiles = allProfiles.filter((profile) => {
    const state = browserFallbackProfileCookieState(profile);
    profileCookieStates.set(profile, state);
    profileStates.push(state);
    if (!state.shouldSkip) return true;
    failures.push({
      target: profile.key || profile.sourceKey || profile.source_key || "browser",
      message: `授权 Cookie 已全部过期，已跳过该浏览器采集 Profile；请重新授权 ${profile.label || profile.domain || profile.key || ""}`.trim(),
      reason: "browser-auth-expired",
      recommendedAction: state.recommendedAction,
    });
    return false;
  });
  if (!profiles.length) {
    const noProfileFailures = failures.length ? failures : [{ target: "browserFallback", message: "没有可用的浏览器采集 Profile" }];
    return {
      ...scraperResult(0, noProfileFailures),
      diagnostics: buildBrowserFallbackDiagnostics(profileStates, { inserted: 0, failures: noProfileFailures }),
    };
  }
  let inserted = 0;
  let browser = null;
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({
      headless: settings.headless !== false,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    const context = await browser.newContext({
      userAgent: settings.userAgent || DEFAULT_USER_AGENT,
      viewport: { width: 1365, height: 900 },
      locale: "zh-CN",
    });
    if (typeof context.route === "function") {
      await context.route("**/*", async (route) => {
        if (isTelegramPublicNetworkUrl(route.request().url())) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
    }
    const cookies = profiles.flatMap(profile => profileCookieStates.get(profile)?.activeCookies || []);
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    const detailPage = captureResultPages && maxDetailPagesPerKeyword > 0 ? await context.newPage() : null;
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    detailPage?.setDefaultTimeout(timeoutMs);
    detailPage?.setDefaultNavigationTimeout(timeoutMs);

    for (const keyword of normalizedKeywords) {
      let remaining = maxItems;
      let detailRemaining = maxDetailPagesPerKeyword;
      for (const profile of profiles) {
        const profileCookieState = profileCookieStates.get(profile) || browserFallbackProfileCookieState(profile);
        if (remaining <= 0) break;
        const seenUrls = new Set();
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 2500) {
          failures.push({ keyword, target: profile.key || profile.sourceKey || "browser", message: "浏览器兜底采集达到本轮时间上限，已停止后续页面" });
          break;
        }
        const urls = resolveSearchUrls(profile, keyword);
        for (const url of urls) {
          if (remaining <= 0) break;
          if (isTelegramPublicNetworkUrl(url)) continue;
          try {
            const pageTimeoutMs = Math.max(2500, Math.min(timeoutMs, Math.max(2500, deadlineAt - Date.now() - 1000)));
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: pageTimeoutMs });
            if (waitMs) await page.waitForTimeout(Math.min(waitMs, Math.max(0, deadlineAt - Date.now() - 1000)));
            const items = await extractPageLinks(page, { baseUrl: url, profile, keyword, maxItems: remaining * 2 });
            const engine = browserSearchEngineName(url);
            for (const item of items) {
              if (seenUrls.has(item.url)) continue;
              seenUrls.add(item.url);
              let detail = null;
              if (detailPage && detailRemaining > 0 && (deadlineAt - Date.now()) > 4000) {
                if (isTelegramPublicNetworkUrl(item.url)) continue;
                try {
                  const detailTimeoutMs = Math.max(2500, Math.min(timeoutMs, Math.max(2500, deadlineAt - Date.now() - 1000)));
                  await detailPage.goto(item.url, { waitUntil: "domcontentloaded", timeout: detailTimeoutMs });
                  if (waitMs) await detailPage.waitForTimeout(Math.min(Math.max(300, Math.floor(waitMs / 2)), Math.max(0, deadlineAt - Date.now() - 1000)));
                  detail = await extractPageDetail(detailPage, { fallback: item });
                  detailRemaining -= 1;
                } catch (error) {
                  failures.push({ keyword, target: `${profile.key || profile.sourceKey || "browser"} detail`, message: `${item.url}: ${error?.message || String(error)}` });
                }
              }
              const finalUrl = detail?.canonicalUrl || item.url;
              const finalTitle = detail?.title || item.title;
              const finalContent = detail?.content || item.content;
              const finalAuthor = detail?.author || profile.label || "Browser";
              const finalPublishedAt = detail?.publishedAt || new Date().toISOString();
              const narrativeSignals = browserFallbackNarrativeSignals({
                title: finalTitle,
                content: finalContent,
                author: finalAuthor,
              });
              const outboundLinks = Array.isArray(detail?.outboundLinks) ? detail.outboundLinks : [];
              const externalLinks = outboundLinks.filter(link => link.same_host !== true);
              const officialLinks = outboundLinks.filter(link => link.kind === "official-reference");
              const socialLinks = outboundLinks.filter(link => link.kind === "social-amplification");
              const linkedDomains = [...new Set(externalLinks.map(link => link.domain).filter(Boolean))].slice(0, 12);
              const profileSourceKeys = [
                profile.sourceKey,
                profile.source_key,
                ...(Array.isArray(profile.sourceKeys) ? profile.sourceKeys : []),
                ...(Array.isArray(profile.source_keys) ? profile.source_keys : []),
              ].map(item => String(item || "").trim()).filter(Boolean);
              const profileAudit = {
                target_source_key: profile.sourceKey || profile.source_key || profile.key || "",
                browser_profile: profile.key || "",
                browser_profile_key: profile.key || "",
                browser_profile_label: profile.label || profile.name || "",
                browser_profile_platform: profile.platform || profile.sourceKey || "",
                browser_profile_source_keys: [...new Set(profileSourceKeys)].slice(0, 12),
                browser_profile_auth_url: profile.authUrl || profile.auth_url || "",
                browser_profile_auth_urls: Array.isArray(profile.authUrls || profile.auth_urls) ? (profile.authUrls || profile.auth_urls).slice(0, 8) : [],
                browser_profile_cookie_domains: Array.isArray(profile.cookieDomains || profile.cookie_domains) ? (profile.cookieDomains || profile.cookie_domains).slice(0, 8) : [],
                browser_profile_match_domains: Array.isArray(profile.matchDomains || profile.match_domains) ? (profile.matchDomains || profile.match_domains).slice(0, 8) : [],
                browser_domain: profile.domain || "",
              };
              const sentiment = analyzeSentiment(`${finalTitle} ${finalContent}`);
              const result = insertSentimentItem({
                platform: profile.platform || profile.sourceKey || "browser",
                url: finalUrl,
                title: finalTitle,
                content: finalContent,
                author: finalAuthor,
                sentiment,
                risk_level: assessRiskLevel({ title: finalTitle, content: finalContent, sentiment }),
                keyword,
                keywords: [keyword],
                published_at: finalPublishedAt,
                source_type: "scraper",
                evidence: {
                  source_key: "browserFallback",
                  evidence_type: "authorized_browser_search_result",
                  metrics: {
                    ...profileAudit,
                    browser_search_engine: engine,
                    browser_search_url: url,
                    browser_url_template: profile.urlTemplate || profile.url_template || "",
                    authorized_cookie_count: profileCookieState.validCookieCount,
                    configured_cookie_count: profileCookieState.cookieCount,
                    expired_cookie_count: profileCookieState.expiredCookieCount,
                    browser_auth_health: profileCookieState.authHealth,
                    browser_auth_recommended_action: profileCookieState.recommendedAction,
                    browser_auth_status_reasons: profileCookieState.statusReasons,
                    browser_result_url: item.url,
                    browser_detail_canonical_url: detail?.canonicalUrl || "",
                    browser_result_snippet_chars: String(item.content || "").length,
                    browser_detail_content_chars: String(finalContent || "").length,
                    browser_detail_extracted: Boolean(detail?.content),
                    browser_detail_strategy: detail?.extractionStrategy || "",
                    browser_detail_author: detail?.author || "",
                    browser_detail_image_url: detail?.imageUrl || "",
                    browser_detail_outlink_count: outboundLinks.length,
                    browser_detail_external_link_count: externalLinks.length,
                    browser_detail_official_link_count: officialLinks.length,
                    browser_detail_social_link_count: socialLinks.length,
                    browser_detail_linked_domains: linkedDomains,
                    browser_detail_outlinks: outboundLinks,
                    ...narrativeSignals,
                  },
                },
                visual_assets: detail?.imageUrl ? [{
                  source_key: "browserFallback",
                  asset_type: "page-image",
                  image_url: detail.imageUrl,
                  metrics: {
                    ...profileAudit,
                    browser_search_engine: engine,
                  },
                }] : [],
                source_metrics: {
                  ...profileAudit,
                  browser_search_engine: engine,
                  browser_fallback: 1,
                  browser_detail_extracted: detail?.content ? 1 : 0,
                  browser_detail_outlink_count: outboundLinks.length,
                  browser_media_semantic_signal_count: Number(narrativeSignals.browser_media_semantic_signal_count || 0),
                },
                domainControls,
                contentControls,
              });
              if (result.inserted) {
                inserted += 1;
                remaining -= 1;
                if (remaining <= 0) break;
              }
            }
          } catch (error) {
            failures.push({ keyword, target: profile.key || profile.sourceKey || "browser", message: `${browserSearchEngineName(url)}: ${error?.message || String(error)}` });
          }
        }
      }
    }
  } catch (error) {
    failures.push({ target: "browserFallback", message: error?.message || String(error) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return {
    ...scraperResult(inserted, failures),
    diagnostics: buildBrowserFallbackDiagnostics(profileStates, { inserted, failures }),
  };
}

export const __test__ = {
  browserSearchEngineName,
  buildSearchUrl,
  extractPageDetail,
  keywordMatch,
  linkMatches,
  normalizePageDetail,
  normalizeCookie,
  normalizeOutboundLinks,
  profileHostMatches,
  buildBrowserFallbackDiagnostics,
  browserFallbackProfileCookieState,
  normalizeProfiles,
  resolveSearchUrls,
  setPlaywrightLoader(loader) {
    playwrightLoader = typeof loader === "function" ? loader : (() => import("playwright"));
  },
};
