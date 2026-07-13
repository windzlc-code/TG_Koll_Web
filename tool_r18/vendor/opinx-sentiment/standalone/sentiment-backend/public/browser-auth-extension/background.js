const DEFAULT_API_BASE = "";
const DEFAULT_AUTH_TOKEN = "";
const DEFAULT_EXTENSION_VERSION = "1.0.9";
const AUTO_SYNC_ALARM = "opinx-browser-auth-auto-sync";
const AUTO_SYNC_INTERVAL_MINUTES = 10;
const MIN_PROFILE_SYNC_GAP_MS = 2 * 60 * 1000;
const CONFIG_REFRESH_GAP_MS = 10 * 60 * 1000;
const LOCAL_API_BASE_CANDIDATES = [
  "http://127.0.0.1:8001",
  "http://localhost:8001",
  "http://127.0.0.1:8003",
  "http://localhost:8003",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
];

const PROFILES = [
  {
    key: "youtube",
    sourceKey: "youtube",
    domain: "youtube.com",
    authUrl: "https://www.youtube.com/",
  },
  {
    key: "reddit",
    sourceKey: "reddit",
    domain: "reddit.com",
    authUrl: "https://www.reddit.com/",
  },
  {
    key: "dcard",
    sourceKey: "dcard",
    domain: "dcard.tw",
    authUrl: "https://www.dcard.tw/",
  },
  {
    key: "threads",
    sourceKey: "threads",
    domain: "threads.com",
    cookieDomains: ["threads.com", "threads.net", "instagram.com", "facebook.com"],
    matchDomains: ["threads.com", "threads.net", "instagram.com", "facebook.com"],
    authUrl: "https://www.threads.com/",
    authUrls: ["https://www.threads.com/", "https://www.instagram.com/accounts/login/"],
  },
  {
    key: "xSearch",
    sourceKey: "xSearch",
    domain: "x.com",
    authUrl: "https://x.com/",
  },
  {
    key: "nownews",
    label: "NOWnews 授权浏览器搜索",
    aliases: ["NOWnews", "NOWnews今日新聞"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "nownews.com",
    authUrl: "https://www.nownews.com/",
  },
  {
    key: "chinatimes",
    label: "中時新聞網 授权浏览器搜索",
    aliases: ["中時新聞網"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "chinatimes.com",
    authUrl: "https://www.chinatimes.com/",
  },
  {
    key: "storm",
    label: "風傳媒 授权浏览器搜索",
    aliases: ["風傳媒"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "storm.mg",
    authUrl: "https://www.storm.mg/",
  },
  {
    key: "upmedia",
    label: "上報 授权浏览器搜索",
    aliases: ["上報"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "upmedia.mg",
    authUrl: "https://www.upmedia.mg/",
  },
  {
    key: "businessweekly",
    label: "商業周刊 授权浏览器搜索",
    aliases: ["商業周刊"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "businessweekly.com.tw",
    authUrl: "https://www.businessweekly.com.tw/",
  },
  {
    key: "cw",
    label: "天下雜誌 授权浏览器搜索",
    aliases: ["天下雜誌"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "cw.com.tw",
    authUrl: "https://www.cw.com.tw/",
  },
  {
    key: "businesstoday",
    label: "今周刊 授权浏览器搜索",
    aliases: ["今周刊"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "businesstoday.com.tw",
    authUrl: "https://www.businesstoday.com.tw/",
  },
  {
    key: "ettoday",
    label: "ETtoday 授权浏览器搜索",
    aliases: ["ETtoday", "ETtoday新聞雲"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "ettoday.net",
    authUrl: "https://www.ettoday.net/",
  },
  {
    key: "udn",
    label: "聯合新聞網 授权浏览器搜索",
    aliases: ["聯合新聞網"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "udn.com",
    authUrl: "https://udn.com/",
  },
  {
    key: "ltn",
    label: "自由時報 授权浏览器搜索",
    aliases: ["自由時報", "自由時報電子報"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "ltn.com.tw",
    authUrl: "https://news.ltn.com.tw/",
  },
  {
    key: "mirrormedia",
    label: "鏡週刊 授权浏览器搜索",
    aliases: ["鏡週刊"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "mirrormedia.mg",
    authUrl: "https://www.mirrormedia.mg/",
  },
  {
    key: "thenewslens",
    label: "關鍵評論網 授权浏览器搜索",
    aliases: ["關鍵評論網"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "thenewslens.com",
    authUrl: "https://www.thenewslens.com/",
  },
  {
    key: "yahooNewsTaiwan",
    label: "Yahoo奇摩新聞 授权浏览器搜索",
    aliases: ["Yahoo奇摩新聞"],
    sourceKey: "yahooTaiwan",
    sourceKeys: ["taiwanNews", "yahooTaiwan", "rssFeeds"],
    domain: "tw.news.yahoo.com",
    authUrl: "https://tw.news.yahoo.com/",
  },
  {
    key: "wealth",
    label: "財訊 授权浏览器搜索",
    aliases: ["財訊"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "wealth.com.tw",
    authUrl: "https://www.wealth.com.tw/",
  },
  {
    key: "moneydj",
    label: "MoneyDJ 授权浏览器搜索",
    aliases: ["MoneyDJ", "MoneyDJ理財網"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "moneydj.com",
    authUrl: "https://www.moneydj.com/",
  },
  {
    key: "cnyes",
    label: "鉅亨網 授权浏览器搜索",
    aliases: ["鉅亨網"],
    sourceKey: "taiwanNews",
    sourceKeys: ["taiwanNews", "rssFeeds"],
    domain: "cnyes.com",
    authUrl: "https://news.cnyes.com/",
  },
];

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function normalizeApiBase(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function apiBase() {
  const values = await storageGet(["apiBase", "apiBaseSource"]);
  const stored = normalizeApiBase(values.apiBase);
  const injected = normalizeApiBase(DEFAULT_API_BASE);
  if (values.apiBaseSource === "manual" && stored) return stored;
  return injected || stored || LOCAL_API_BASE_CANDIDATES[0];
}

async function authToken() {
  const values = await storageGet(["authToken"]);
  return String(values.authToken || DEFAULT_AUTH_TOKEN || "").trim();
}

async function fetchExtensionConfigFromBase(base, token) {
  const response = await fetch(`${base}/browser-auth-extension/config.json?t=${Date.now()}`, {
    cache: "no-store",
    credentials: "include",
    headers: token ? { "x-sentiment-browser-auth": token } : {},
  });
  if (!response.ok) {
    throw new Error(`配置刷新失败：HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(payload?.error || "配置刷新失败");
  }
  return payload;
}

async function discoverApiBase(currentBase, token) {
  const bases = [currentBase, DEFAULT_API_BASE, ...LOCAL_API_BASE_CANDIDATES]
    .map(normalizeApiBase)
    .filter(Boolean);
  const uniqueBases = [...new Set(bases)];
  let lastError = null;
  for (const base of uniqueBases) {
    try {
      const payload = await fetchExtensionConfigFromBase(base, token);
      return { base, payload };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法识别可用后端地址");
}

async function refreshExtensionConfig(options = {}) {
  if (!options.force) {
    const values = await storageGet(["lastConfigRefreshAt"]);
    const lastRefreshAt = Date.parse(values.lastConfigRefreshAt || "");
    if (Number.isFinite(lastRefreshAt) && Date.now() - lastRefreshAt < CONFIG_REFRESH_GAP_MS) {
      return { ok: true, skipped: true, reason: "recently-refreshed" };
    }
  }
  const base = await apiBase();
  const token = await authToken();
  const discovered = await discoverApiBase(base, token).catch(() => null);
  if (discovered) {
    const payload = discovered.payload;
    const next = {
      lastConfigRefreshAt: new Date().toISOString(),
      extensionVersion: String(payload.version || DEFAULT_EXTENSION_VERSION),
      // The request that returned this config is the verified endpoint. Do not
      // let a stale apiBase value from an older deployment replace it.
      apiBase: normalizeApiBase(discovered.base),
    };
    if (payload.authToken) next.authToken = String(payload.authToken).trim();
    if (Array.isArray(payload.profiles) && payload.profiles.length) next.profiles = payload.profiles;
    await storageSet(next);
    return { ok: true, version: next.extensionVersion, profileCount: Array.isArray(next.profiles) ? next.profiles.length : undefined };
  }
  const response = await fetch(`${base}/browser-auth-extension/config.json?t=${Date.now()}`, {
    cache: "no-store",
    credentials: "include",
    headers: token ? { "x-sentiment-browser-auth": token } : {},
  });
  if (!response.ok) {
    throw new Error(`配置刷新失败：HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(payload?.error || "配置刷新失败");
  }
  const next = {
    lastConfigRefreshAt: new Date().toISOString(),
    extensionVersion: String(payload.version || DEFAULT_EXTENSION_VERSION),
    apiBase: normalizeApiBase(base),
  };
  if (payload.authToken) next.authToken = String(payload.authToken).trim();
  if (Array.isArray(payload.profiles) && payload.profiles.length) next.profiles = payload.profiles;
  await storageSet(next);
  return { ok: true, version: next.extensionVersion, profileCount: Array.isArray(next.profiles) ? next.profiles.length : undefined };
}

async function activeProfiles() {
  const values = await storageGet(["profiles"]);
  return Array.isArray(values.profiles) && values.profiles.length ? values.profiles : PROFILES;
}

function profilesForUrlFromList(url = "", profiles = PROFILES) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const normalizeDomain = (domain = "") => String(domain || "").replace(/^\.+/, "").replace(/^www\./, "");
    return profiles.filter(profile => {
      const domains = [profile.domain, ...(profile.matchDomains || []), ...(profile.cookieDomains || [])]
        .map(normalizeDomain)
        .filter(Boolean);
      return [...new Set(domains)].some(domain => host === domain || host.endsWith(`.${domain}`));
    });
  } catch {
    return [];
  }
}

async function profilesForUrl(url = "") {
  return profilesForUrlFromList(url, await activeProfiles());
}

function cookieUrlForProfile(profile) {
  return `https://${profile.domain}/`;
}

function cookieKey(cookie = {}) {
  return [
    cookie.storeId || "",
    cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : "",
    cookie.domain || "",
    cookie.path || "",
    cookie.name || "",
  ].join("|");
}

async function getCookiesForDomain(domain = "") {
  const normalized = String(domain || "").replace(/^\.+/, "").replace(/^www\./, "");
  if (!normalized) return [];
  const results = await Promise.allSettled([
    chrome.cookies.getAll({ domain: normalized }),
    chrome.cookies.getAll({ url: `https://${normalized}/` }),
    chrome.cookies.getAll({ url: `https://www.${normalized}/` }),
  ]);
  const seen = new Set();
  return results
    .filter(result => result.status === "fulfilled")
    .flatMap(result => result.value || [])
    .filter(cookie => {
      const key = cookieKey(cookie);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function syncProfileCookies(profile, options = {}) {
  if (!options.force) {
    const values = await storageGet([`lastSync:${profile.key}`]);
    const lastSyncAt = Date.parse(values[`lastSync:${profile.key}`] || "");
    if (Number.isFinite(lastSyncAt) && Date.now() - lastSyncAt < MIN_PROFILE_SYNC_GAP_MS) {
      return { ok: true, skipped: true, reason: "recently-synced" };
    }
  }
  const domains = [profile.domain, ...(profile.cookieDomains || [])]
    .map(domain => String(domain || "").replace(/^\.+/, "").replace(/^www\./, ""))
    .filter(Boolean);
  const uniqueDomains = [...new Set(domains)];
  const cookieGroups = await Promise.all(uniqueDomains.map(async domain => ({
    domain,
    cookies: await getCookiesForDomain(domain),
  })));
  const cookies = cookieGroups.flatMap(group => group.cookies);
  const domainSummary = cookieGroups.map(group => `${group.domain} ${group.cookies.length}`).join("，");
  const usefulCookies = cookies
    .filter(cookie => cookie.name && cookie.value)
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || `.${profile.domain}`,
      path: cookie.path || "/",
      httpOnly: Boolean(cookie.httpOnly),
      secure: cookie.secure !== false,
      sameSite: cookie.sameSite === "strict" ? "Strict" : cookie.sameSite === "no_restriction" ? "None" : "Lax",
      expires: cookie.expirationDate,
    }));
  if (!usefulCookies.length) {
    await storageSet({ lastStatus: `${profile.key}: 未读取到 Cookie（${domainSummary}），请先登录或检查扩展站点权限` });
    return { ok: false, savedCookieCount: 0 };
  }
  let token = await authToken();
  if (!token) {
    await refreshExtensionConfig({ force: true }).catch(() => undefined);
    token = await authToken();
  }
  if (!token) {
    await storageSet({ lastStatus: `${profile.key}: missing auth token` });
    return { ok: false, savedCookieCount: 0, error: "missing auth token" };
  }
  const postCookies = async (nextToken) => {
    const nextBase = await apiBase();
    const response = await fetch(`${nextBase}/api/sentiment/browser-auth/cookies`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sentiment-browser-auth": nextToken,
      },
      body: JSON.stringify({
        profileKey: profile.key,
        sourceKey: profile.sourceKey,
        domain: profile.domain,
        cookies: usefulCookies,
      }),
    });
    const result = await response.json().catch(() => ({}));
    return { response, result };
  };
  let { response, result } = await postCookies(token);
  if (response.status === 403 || /invalid browser auth token/i.test(String(result.error || ""))) {
    await refreshExtensionConfig({ force: true });
    token = await authToken();
    ({ response, result } = await postCookies(token));
  }
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `同步失败：${response.status}`);
  }
  await storageSet({
    lastStatus: `${profile.key}: 已同步 ${result.savedCookieCount || usefulCookies.length} 个 Cookie（${domainSummary}）`,
    [`lastSync:${profile.key}`]: new Date().toISOString(),
  });
  return result;
}

async function openAuthorizationPages() {
  await refreshExtensionConfig({ force: true }).catch(() => undefined);
  const profiles = await activeProfiles();
  for (const profile of profiles) {
    const urls = Array.isArray(profile.authUrls) && profile.authUrls.length ? profile.authUrls : [profile.authUrl];
    for (const url of urls.filter(Boolean)) {
      await chrome.tabs.create({ url, active: false });
    }
  }
  await storageSet({ lastStatus: "已打开授权页面，登录完成后扩展会自动同步 Cookie" });
}

async function syncAllProfiles(options = {}) {
  await refreshExtensionConfig(options).catch(() => undefined);
  const profiles = await activeProfiles();
  const token = await authToken();
  if (!token) {
    await storageSet({ lastStatus: "missing auth token" });
    return [];
  }
  const results = await Promise.allSettled(profiles.map(profile => syncProfileCookies(profile, options)));
  const okCount = results.filter(result => result.status === "fulfilled" && result.value?.ok).length;
  const failed = results
    .map((result, index) => ({ result, profile: profiles[index] }))
    .filter(item => item.result.status === "rejected" || !item.result.value?.ok);
  const failedText = failed.slice(0, 3).map(item => {
    if (item.result.status === "rejected") return `${item.profile.key}: ${item.result.reason?.message || item.result.reason}`;
    return `${item.profile.key}: ${item.result.value?.error || item.result.value?.reason || "no valid cookies"}`;
  }).join("；");
  await storageSet({
    lastAutoSyncAt: new Date().toISOString(),
    lastStatus: failed.length ? `auto sync ${okCount}/${profiles.length}; ${failedText}` : `auto sync ${okCount}/${profiles.length}`,
  });
  return results;
}

function ensureAutoSyncAlarm() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(AUTO_SYNC_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const values = await storageGet(["apiBase", "apiBaseSource", "authToken"]);
  const stored = normalizeApiBase(values.apiBase);
  const keepManualBase = values.apiBaseSource === "manual" && Boolean(stored);
  await storageSet({
    apiBase: keepManualBase ? stored : normalizeApiBase(DEFAULT_API_BASE),
    apiBaseSource: keepManualBase ? "manual" : "injected",
    authToken: values.authToken || "",
    profiles: PROFILES,
    lastStatus: "授权助手已安装",
  });
  ensureAutoSyncAlarm();
  await refreshExtensionConfig({ force: true }).catch(() => undefined);
  void syncAllProfiles({ force: true }).catch(() => undefined);
});

chrome.runtime.onStartup?.addListener(() => {
  ensureAutoSyncAlarm();
  void refreshExtensionConfig().catch(() => undefined);
  void syncAllProfiles().catch(() => undefined);
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name !== AUTO_SYNC_ALARM) return;
  void syncAllProfiles().catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url) return;
  profilesForUrl(tab.url).then(profiles => {
    if (!profiles.length) return null;
    return Promise.allSettled(profiles.map(profile => syncProfileCookies(profile))).then(async results => {
    const statusText = results.map((result, index) => {
      const profile = profiles[index];
      return result.status === "fulfilled"
        ? `${profile.key}: OK`
        : `${profile.key}: ${result.reason?.message || result.reason}`;
    }).join("；");
    await storageSet({ lastStatus: statusText });
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "open-auth-pages") {
      await openAuthorizationPages();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "sync-current-tab") {
      await refreshExtensionConfig({ force: true }).catch(() => undefined);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const profiles = await profilesForUrl(tab?.url || "");
      if (!profiles.length) {
        sendResponse({ ok: false, error: "当前标签页不是受支持的授权站点" });
        return;
      }
      const results = await Promise.allSettled(profiles.map(profile => syncProfileCookies(profile, { force: true })));
      const failures = results
        .map((result, index) => ({ result, profile: profiles[index] }))
        .filter(item => item.result.status === "rejected");
      if (failures.length === results.length) {
        sendResponse({ ok: false, error: failures.map(item => `${item.profile.key}: ${item.result.reason?.message || item.result.reason}`).join("；") });
        return;
      }
      sendResponse({
        ok: true,
        result: results.map((result, index) => ({
          profileKey: profiles[index].key,
          ok: result.status === "fulfilled",
          error: result.status === "rejected" ? String(result.reason?.message || result.reason) : undefined,
          value: result.status === "fulfilled" ? result.value : undefined,
        })),
      });
      return;
    }
    if (message?.type === "set-api-base") {
      const base = normalizeApiBase(message.apiBase || DEFAULT_API_BASE);
      if (!base) {
        sendResponse({ ok: false, error: "请填写后端地址" });
        return;
      }
      const source = message.apiBaseSource === "manual" ? "manual" : "injected";
      await storageSet({ apiBase: base, apiBaseSource: source });
      ensureAutoSyncAlarm();
      await refreshExtensionConfig({ force: true }).catch(() => undefined);
      const values = await storageGet(["apiBase"]);
      sendResponse({ ok: true, apiBase: normalizeApiBase(values.apiBase || base) });
      return;
    }
    if (message?.type === "set-auth-token") {
      const token = String(message.authToken || "").trim();
      await storageSet({ authToken: token });
      ensureAutoSyncAlarm();
      if (token) void syncAllProfiles({ force: true }).catch(() => undefined);
      sendResponse({ ok: true, hasAuthToken: Boolean(token) });
      return;
    }
    sendResponse({ ok: false, error: "unknown message" });
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

function bootAutoSync() {
  ensureAutoSyncAlarm();
  void syncAllProfiles({ force: true }).catch(() => undefined);
}

bootAutoSync();
