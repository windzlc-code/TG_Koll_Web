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

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== "object") return null;
  const name = String(cookie.name || "").trim();
  const value = String(cookie.value || "").trim();
  if (!name || !value) return null;
  const rawDomain = String(cookie.domain || ".threads.com").trim() || ".threads.com";
  const domain = rawDomain.startsWith(".") ? rawDomain : `.${rawDomain.replace(/^https?:\/\//i, "").split("/")[0]}`;
  const expires = Number(cookie.expires);
  return {
    name,
    value,
    domain,
    path: String(cookie.path || "/").trim() || "/",
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None" ? cookie.sameSite : "Lax",
    ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
  };
}

function hasThreadsComSession(cookies) {
  const now = Date.now() / 1000;
  return cookies.some((cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    const expires = Number(cookie.expires);
    return String(cookie.name || "").toLowerCase() === "sessionid"
      && String(cookie.value || "").trim()
      && (domain === "threads.com" || domain.endsWith(".threads.com"))
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

async function main() {
  const input = JSON.parse(await readStdin() || "{}");
  const cookies = Array.isArray(input.cookies) ? input.cookies.map(normalizeCookie).filter(Boolean) : [];
  if (!hasThreadsComSession(cookies)) {
    console.log(JSON.stringify({ ok: false, status: "invalid", reason: "missing threads.com sessionid" }));
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
    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const url = page.url();
    const refreshedCookies = await context.cookies(["https://www.threads.com/", "https://www.threads.net/"]);
    const loginWall = /accounts\/login|log in|login|登入|登录|使用 Instagram|Instagram 帳號|Instagram 账号/i.test(`${title}\n${url}\n${text}`);
    const retained = hasThreadsComSession(refreshedCookies);
    await context.close().catch(() => undefined);
    console.log(JSON.stringify({
      ok: !loginWall && retained,
      status: !loginWall && retained ? "verified" : "invalid",
      reason: loginWall ? "login wall detected" : retained ? "session retained" : "session not retained",
      url,
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
