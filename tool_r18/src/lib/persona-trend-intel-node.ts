import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import type { DramaSetup } from "@/types/drama";

type LocaleInfo = {
  label: string;
  hl: string;
  gl: string;
  ceid: string;
  suffix: string;
  socialTerms: string;
};

const CACHE_FILE = "persona-trend-intel-cache.json";

function todayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hashShort(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function normalizeTopic(value: string): string {
  return value
    .replace(/(創作者|专家|專家|達人|老师|老師|規劃師|咨询师|諮詢師|主妇|主婦|媽媽|爸爸|創作)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlDecode(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickLocale(setup: DramaSetup): LocaleInfo {
  const raw = `${(setup as any).targetMarket || ""} ${(setup as any).localeKey || ""} ${(setup as any).chineseScript || ""}`.toLowerCase();
  if (/hk|香港/.test(raw)) {
    return { label: "香港", hl: "zh-HK", gl: "HK", ceid: "HK:zh-Hant", suffix: "香港 最新", socialTerms: "Threads LIHKG 香港討論" };
  }
  if (/jp|japan|日本/.test(raw)) {
    return { label: "日本", hl: "ja", gl: "JP", ceid: "JP:ja", suffix: "日本 最新 トレンド", socialTerms: "X Instagram 日本 トレンド" };
  }
  if (/kr|korea|韓|韩/.test(raw)) {
    return { label: "韓國", hl: "ko", gl: "KR", ceid: "KR:ko", suffix: "한국 최신 트렌드", socialTerms: "X Instagram 한국 트렌드" };
  }
  if (/west|us|en|english/.test(raw)) {
    return { label: "美國", hl: "en-US", gl: "US", ceid: "US:en", suffix: "latest trending", socialTerms: "TikTok Instagram Reddit discussion" };
  }
  return { label: "台灣", hl: "zh-TW", gl: "TW", ceid: "TW:zh-Hant", suffix: "台灣 最新", socialTerms: "Threads Dcard PTT 台灣討論" };
}

export function buildPersonaTrendTopics(setup: DramaSetup, personaName?: string): string[] {
  const setupAny = setup as any;
  const topics = [
    ...(Array.isArray(setupAny.trendTopics) ? setupAny.trendTopics : []),
    ...(Array.isArray(setup.genres) ? setup.genres : []),
    personaName || "",
  ]
    .map((topic) => normalizeTopic(String(topic || "")))
    .filter((topic) => topic.length >= 2);
  return Array.from(new Set(topics)).slice(0, 3);
}

function readCache(): Record<string, { updatedAt: string; text: string }> {
  try {
    const file = resolveRuntimeFile(CACHE_FILE);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, { updatedAt: string; text: string }>) {
  try {
    const today = todayKey();
    const cleaned = Object.fromEntries(Object.entries(cache).filter(([, value]) => value.updatedAt?.startsWith(today)));
    fs.writeFileSync(resolveRuntimeFile(CACHE_FILE), JSON.stringify(cleaned, null, 2), "utf8");
  } catch {
    // Cache failure should never block post generation.
  }
}

async function fetchGoogleNewsRss(query: string, locale: LocaleInfo, timeoutMs: number): Promise<string[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", locale.hl);
  url.searchParams.set("gl", locale.gl);
  url.searchParams.set("ceid", locale.ceid);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 Automatic-script trend fetcher" },
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return Array.from(xml.matchAll(/<item\b[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?(?:<source[^>]*>([\s\S]*?)<\/source>)?/g))
      .map((match) => {
        const title = htmlDecode(match[1] || "");
        const source = htmlDecode(match[2] || "");
        return source ? `${title}（${source}）` : title;
      })
      .filter((title) => title && !/^Google News/i.test(title))
      .slice(0, 4);
  } catch {
    const proxiedXml = await fetchTextViaProxy(url, timeoutMs);
    return parseGoogleNewsRssItems(proxiedXml);
  } finally {
    clearTimeout(timer);
  }
}

function parseGoogleNewsRssItems(xml: string): string[] {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<item\b[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?(?:<source[^>]*>([\s\S]*?)<\/source>)?/g))
    .map((match) => {
      const title = htmlDecode(match[1] || "");
      const source = htmlDecode(match[2] || "");
      return source ? `${title}（${source}）` : title;
    })
    .filter((title) => title && !/^Google News/i.test(title))
    .slice(0, 4);
}

function getProxyUrl(): URL | null {
  const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "";
  if (!raw.trim()) return null;
  try {
    const proxy = new URL(raw);
    return proxy.protocol === "http:" ? proxy : null;
  } catch {
    return null;
  }
}

async function fetchTextViaProxy(url: URL, timeoutMs: number): Promise<string> {
  const proxy = getProxyUrl();
  if (!proxy) return "";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish("");
    }, timeoutMs);
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
    });

    socket.once("connect", () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : "";
      socket.write(`CONNECT ${url.hostname}:443 HTTP/1.1\r\nHost: ${url.hostname}:443\r\n${auth}\r\n`);
    });

    socket.once("error", () => finish(""));
    socket.once("data", (chunk) => {
      const head = chunk.toString("latin1");
      if (!/^HTTP\/1\.[01] 200\b/.test(head)) {
        socket.destroy();
        finish("");
        return;
      }
      const secure = tls.connect({
        socket,
        servername: url.hostname,
      });
      let data = "";
      secure.setEncoding("utf8");
      secure.once("secureConnect", () => {
        secure.write([
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.hostname}`,
          "User-Agent: Mozilla/5.0 Automatic-script trend fetcher",
          "Accept: application/rss+xml, application/xml, text/xml",
          "Accept-Encoding: identity",
          "Connection: close",
          "",
          "",
        ].join("\r\n"));
      });
      secure.on("data", (part) => {
        data += part;
      });
      secure.once("error", () => finish(""));
      secure.once("end", () => {
        const bodyIndex = data.indexOf("\r\n\r\n");
        const header = bodyIndex >= 0 ? data.slice(0, bodyIndex) : "";
        const body = bodyIndex >= 0 ? data.slice(bodyIndex + 4) : data;
        finish(/^HTTP\/1\.[01] 200\b/.test(header) ? body : "");
      });
    });
  });
}

function buildFallbackIntel(topics: string[], locale: LocaleInfo): string {
  const topicLine = topics.join("、") || "日常生活";
  return [
    "【本地兜底舆情摘要】",
    `地區：${locale.label}`,
    `主題方向：${topicLine}`,
    "可用切角：把當天社群正在聊的話題壓成個人生活小事故、通勤觀察、吃喝消費、朋友會留言的短句",
    "寫作提醒：不能像新聞摘要；必須寫成真人剛看到時事後的自然反應",
  ].join("\n");
}

export async function fetchPersonaTrendIntelForNode(
  setup: DramaSetup,
  personaId?: string,
  personaName?: string,
  options: { bypassCache?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const locale = pickLocale(setup);
  const topics = buildPersonaTrendTopics(setup, personaName);
  const cacheKey = `${todayKey()}_${personaId || "anonymous"}_${hashShort(JSON.stringify({ topics, locale }))}`;
  const cache = readCache();
  if (!options.bypassCache && cache[cacheKey]?.text) return cache[cacheKey].text;

  const timeoutMs = Math.max(2500, options.timeoutMs || 5500);
  const targetTopics = topics.length ? topics.slice(0, 2) : ["生活"];
  const newsQueries = targetTopics.map((topic) => `${topic} ${locale.suffix}`);
  const socialQueries = targetTopics.map((topic) => `${topic} ${locale.socialTerms}`);

  const [newsResults, socialResults] = await Promise.all([
    Promise.all(newsQueries.map((query) => fetchGoogleNewsRss(query, locale, timeoutMs))),
    Promise.all(socialQueries.map((query) => fetchGoogleNewsRss(query, locale, timeoutMs))),
  ]);

  const news = newsResults.flat().slice(0, 6);
  const social = socialResults.flat().slice(0, 6);
  const text = news.length || social.length
    ? [
        `【新聞與趨勢】\n${news.length ? news.map((item) => `- ${item}`).join("\n") : "- 未取得可靠新聞結果"}`,
        `【社媒討論】\n${social.length ? social.map((item) => `- ${item}`).join("\n") : "- 未取得可靠社群結果"}`,
        `【地區熱梗 / 網路語料】\n- 地區：${locale.label}\n- 話題種子：${targetTopics.join("、")}\n- 生成時要用真人口吻吸收熱點，不要直接複述新聞標題`,
      ].join("\n\n")
    : buildFallbackIntel(targetTopics, locale);

  cache[cacheKey] = { updatedAt: todayKey(), text };
  writeCache(cache);
  return text;
}
