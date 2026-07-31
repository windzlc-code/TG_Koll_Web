import { chromium } from "playwright";
import fs from "node:fs";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function normalizeExpiry(value) {
  let expires = Number(value);
  if (!Number.isFinite(expires) || expires <= 0) return -1;
  while (expires > 253402300799) expires /= 1000;
  return expires;
}

function normalizeCookie(cookie, fallbackDomain) {
  if (!cookie || typeof cookie !== "object") return null;
  const name = String(cookie.name || "").trim();
  const value = String(cookie.value || "").trim();
  if (!name || !value) return null;
  const rawDomain = String(cookie.domain || fallbackDomain).trim() || fallbackDomain;
  const domain = rawDomain.startsWith(".") ? rawDomain : `.${rawDomain.replace(/^https?:\/\//i, "").split("/")[0]}`;
  const expires = normalizeExpiry(cookie.expires);
  return {
    name,
    value,
    domain,
    path: String(cookie.path || "/").trim() || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None" ? cookie.sameSite : "Lax",
    ...(expires > 0 ? { expires } : {}),
  };
}

function hasPlatformSession(cookies, domains) {
  const now = Date.now() / 1000;
  return cookies.some((cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    const expires = Number(cookie.expires);
    return String(cookie.name || "").toLowerCase() === "sessionid"
      && String(cookie.value || "").trim()
      && domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
      && (!Number.isFinite(expires) || expires <= 0 || expires > now);
  });
}

function resolveChromeExecutablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function buildChromiumLaunchOptions() {
  const executablePath = resolveChromeExecutablePath();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
}

function searchProbeResult(status, reason, httpStatus = null) {
  const searchUsable = status === "available" ? true : status === "unavailable" ? false : null;
  return {
    searchUsable,
    searchStatus: status,
    searchReason: reason,
    ...(Number.isFinite(httpStatus) ? { searchHttpStatus: httpStatus } : {}),
  };
}

async function probeInstagramSearch(page) {
  const result = await page.evaluate(async () => {
    try {
      const response = await fetch("/api/v1/tags/web_info/?tag_name=news", {
        credentials: "include",
        headers: {
          "x-ig-app-id": "936619743392459",
          "x-requested-with": "XMLHttpRequest",
        },
      });
      return { status: response.status };
    } catch (error) {
      return { status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  });
  if (result.status >= 200 && result.status < 300) {
    return searchProbeResult("available", `Instagram search returned ${result.status}`, result.status);
  }
  if (result.status === 429) {
    return searchProbeResult("limited", "Instagram search is rate limited", result.status);
  }
  if (result.status === 401 || result.status === 403) {
    return searchProbeResult("unavailable", `Instagram search returned ${result.status}`, result.status);
  }
  return searchProbeResult("probe_failed", result.error || `Instagram search returned ${result.status || "no response"}`, result.status);
}

async function probeThreadsSearch(page, loginWallPattern) {
  const graphqlStatuses = [];
  const onResponse = (response) => {
    const responseUrl = response.url();
    if (responseUrl.includes("/graphql/query") || responseUrl.includes("/api/graphql")) {
      graphqlStatuses.push(response.status());
    }
  };
  page.on("response", onResponse);
  const searchUrl = `https://www.threads.com/search?q=${encodeURIComponent("news")}&filter=recent`;
  try {
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(2200);
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const currentUrl = page.url();
    if (loginWallPattern.test(`${currentUrl}\n${bodyText}`)) {
      return searchProbeResult("unavailable", "Threads search redirected to login");
    }
    if (graphqlStatuses.some((status) => status === 429)) {
      return searchProbeResult("limited", "Threads search is rate limited", 429);
    }
    if (graphqlStatuses.some((status) => status === 401 || status === 403)) {
      return searchProbeResult("unavailable", "Threads search authorization was rejected");
    }
    const successfulGraphql = graphqlStatuses.find((status) => status >= 200 && status < 300);
    if (successfulGraphql) {
      return searchProbeResult("available", `Threads search GraphQL returned ${successfulGraphql}`, successfulGraphql);
    }
    const pageEvidence = await page.evaluate(() => {
      const hydration = Array.from(document.scripts)
        .map((script) => script.textContent || "")
        .join("\n");
      return {
        postLinks: document.querySelectorAll('a[href*="/post/"]').length,
        hasSearchPayload: /text_post_app_info|like_count|search_results/i.test(hydration),
      };
    }).catch(() => ({ postLinks: 0, hasSearchPayload: false }));
    if (pageEvidence.postLinks > 0 || pageEvidence.hasSearchPayload) {
      return searchProbeResult("available", "Threads search results were rendered");
    }
    return searchProbeResult("probe_failed", "Threads search returned no verifiable result payload");
  } finally {
    page.off("response", onResponse);
  }
}

async function main() {
  const input = JSON.parse(await readStdin() || "{}");
  const platform = String(input.platform || "threads").trim().toLowerCase() === "instagram" ? "instagram" : "threads";
  const settings = platform === "instagram"
    ? {
        label: "Instagram",
        domains: ["instagram.com"],
        fallbackDomain: ".instagram.com",
        url: "https://www.instagram.com/",
        cookieUrls: ["https://www.instagram.com/"],
        loginWall: /accounts\/login|log in to instagram|登录 instagram|登入 instagram/i,
      }
    : {
        label: "Threads",
        domains: ["threads.com", "threads.net"],
        fallbackDomain: ".threads.com",
        url: "https://www.threads.com/",
        cookieUrls: ["https://www.threads.com/", "https://www.threads.net/"],
        loginWall: /accounts\/login|log in or sign up for threads|log in with instagram|登录或注册 threads|使用 instagram 帐号/i,
      };
  const cookies = Array.isArray(input.cookies)
    ? input.cookies.map((cookie) => normalizeCookie(cookie, settings.fallbackDomain)).filter(Boolean)
    : [];
  if (!hasPlatformSession(cookies, settings.domains)) {
    console.log(JSON.stringify({ ok: false, status: "invalid", reason: `missing ${settings.label} sessionid` }));
    return;
  }

  let browser;
  try {
    browser = await chromium.launch(buildChromiumLaunchOptions());
    const context = await browser.newContext({
      locale: "zh-TW",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(settings.url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const url = page.url();
    const refreshedCookies = await context.cookies(settings.cookieUrls);
    const loginWall = settings.loginWall.test(`${title}\n${url}\n${text}`);
    const retained = hasPlatformSession(refreshedCookies, settings.domains);
    const authenticated = !loginWall && retained;
    const searchProbe = authenticated
      ? platform === "instagram"
        ? await probeInstagramSearch(page)
        : await probeThreadsSearch(page, settings.loginWall)
      : searchProbeResult("unavailable", "Login session is unavailable");
    await context.close().catch(() => undefined);
    console.log(JSON.stringify({
      ok: authenticated,
      status: authenticated ? "verified" : "invalid",
      reason: loginWall ? "login wall detected" : retained ? "session retained" : "session not retained",
      url,
      ...searchProbe,
    }));
  } finally {
    await browser?.close?.().catch(() => undefined);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: null,
    status: "probe_failed",
    reason: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 0;
});
