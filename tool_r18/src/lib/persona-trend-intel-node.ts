import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import type { DramaSetup } from "@/types/drama";

export type LocaleInfo = {
  label: string;
  hl: string;
  gl: string;
  ceid: string;
  suffix: string;
  socialTerms: string;
};

const CACHE_FILE = "persona-trend-intel-cache.json";
const TREND_CACHE_TTL_MS = 20 * 60 * 1000;
const TAIWAN_PREFERRED_NEWS_DOMAINS = [
  "money.udn.com",
  "finance.ettoday.net",
  "house.ettoday.net",
  "chinatimes.com",
  "ctee.com.tw",
  "news.housefun.com.tw",
  "home.housetube.tw",
  "urbanrenewal.wealth.com.tw",
  "businessinsider.tw",
  "news.pts.org.tw",
  "estate.ltn.com.tw",
  "moneyweekly.com.tw",
  "bella.tw",
  "94m.com.tw",
  "miaoli.gov.tw",
] as const;
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiDateKey(date = new Date()): string {
  const parts = Object.fromEntries(
    SHANGHAI_DATE_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  return `${year}-${month}-${day}`;
}

function todayKey(date = new Date()): string {
  return shanghaiDateKey(date);
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
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const cleaned = Object.fromEntries(Object.entries(cache).filter(([, value]) => {
      const updatedAt = Date.parse(value.updatedAt || "");
      return Number.isFinite(updatedAt) && updatedAt >= cutoff;
    }));
    fs.writeFileSync(resolveRuntimeFile(CACHE_FILE), JSON.stringify(cleaned, null, 2), "utf8");
  } catch {
    // Cache failure should never block post generation.
  }
}

function cacheEntryIsFresh(entry: { updatedAt: string; text: string } | undefined): boolean {
  if (!entry?.text) return false;
  const updatedAt = Date.parse(entry.updatedAt || "");
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < TREND_CACHE_TTL_MS;
}

function uniqueHeadlines(rows: string[]): string[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.replace(/[\s，。；;：:、\-_/（）()]/g, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function topicMatchNeedles(topics: string[]): string[] {
  const needles = topics.flatMap((topic) => {
    const clean = normalizeTopic(topic).replace(/\s+/g, "");
    if (!clean) return [];
    const parts = clean.split(/[|,/，、；;：:\s]+/).filter((part) => part.length >= 2);
    const semanticAliases: Record<string, string[]> = {
      房市: ["房地產", "不動產", "住宅", "房價", "買房", "租屋", "都更", "建案", "建商", "地產"],
      不動產: ["房市", "房地產", "住宅", "房價", "土地", "租屋", "都更", "建案", "建商", "地產"],
      房地產: ["房市", "不動產", "住宅", "房價", "土地", "租屋", "都更", "建案", "建商", "地產"],
      財經: ["金融", "經濟", "股市", "薪資", "利率", "央行", "投資", "產業"],
    };
    const aliases = Object.entries(semanticAliases)
      .filter(([key]) => clean.includes(key))
      .flatMap(([, values]) => values);
    if (clean.length <= 4) return [clean, ...parts, ...aliases];
    const trigrams = Array.from({ length: Math.max(0, clean.length - 2) }, (_, index) => clean.slice(index, index + 3));
    return [clean, ...parts, ...aliases, ...trigrams];
  });
  return Array.from(new Set(needles.map((needle) => needle.toLowerCase()).filter(Boolean)));
}

export function headlineMatchesPersonaTopics(headline: string, topics: string[]): boolean {
  const normalizedHeadline = String(headline || "").replace(/\s+/g, "").toLowerCase();
  if (!normalizedHeadline) return false;
  const needles = topicMatchNeedles(topics);
  return needles.some((needle) => normalizedHeadline.includes(needle));
}

export function buildPreferredNewsQueries(topic: string, locale: LocaleInfo): string[] {
  const cleanTopic = normalizeTopic(topic);
  if (!cleanTopic || locale.label !== "台灣") return [];
  const groups = [
    TAIWAN_PREFERRED_NEWS_DOMAINS.slice(0, 7),
    TAIWAN_PREFERRED_NEWS_DOMAINS.slice(7),
  ];
  return groups.map((domains) => `${cleanTopic} (${domains.map((domain) => `site:${domain}`).join(" OR ")}) when:7d`);
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

    socket.on("error", () => finish(""));
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
      secure.on("error", () => finish(""));
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
  if (!options.bypassCache && cacheEntryIsFresh(cache[cacheKey])) return cache[cacheKey].text;

  const timeoutMs = Math.max(2500, options.timeoutMs || 5500);
  const targetTopics = topics.length ? topics.slice(0, 2) : ["生活"];
  const preferredNewsQueries = targetTopics.flatMap((topic) => buildPreferredNewsQueries(topic, locale));
  const fallbackNewsQueries = targetTopics.map((topic) => `${topic} ${locale.suffix} when:7d`);
  const socialQueries = targetTopics.map((topic) => `${topic} ${locale.socialTerms}`);

  const [preferredNewsResults, fallbackNewsResults, socialResults] = await Promise.all([
    Promise.all(preferredNewsQueries.map((query) => fetchGoogleNewsRss(query, locale, timeoutMs))),
    Promise.all(fallbackNewsQueries.map((query) => fetchGoogleNewsRss(query, locale, timeoutMs))),
    Promise.all(socialQueries.map((query) => fetchGoogleNewsRss(query, locale, timeoutMs))),
  ]);

  const preferredNews = uniqueHeadlines(preferredNewsResults.flat())
    .filter((headline) => headlineMatchesPersonaTopics(headline, targetTopics))
    .slice(0, 6);
  const fallbackNews = uniqueHeadlines(fallbackNewsResults.flat())
    .filter((headline) => headlineMatchesPersonaTopics(headline, targetTopics))
    .slice(0, 6);
  const news = uniqueHeadlines([...preferredNews, ...fallbackNews]).slice(0, 8);
  const social = uniqueHeadlines(socialResults.flat())
    .filter((headline) => headlineMatchesPersonaTopics(headline, targetTopics))
    .slice(0, 6);
  const fetchedAt = new Date().toISOString();
  const text = news.length || social.length
    ? [
        `【即時新聞熱點｜${fetchedAt}】\n${news.length ? news.map((item) => `- ${item}`).join("\n") : "- 未取得可靠新聞結果"}`,
        `【指定台灣新聞來源命中】\n- ${preferredNews.length} 則；其餘結果僅在指定來源不足時補充`,
        `【社媒討論】\n${social.length ? social.map((item) => `- ${item}`).join("\n") : "- 未取得可靠社群結果"}`,
        `【使用規則】\n- 地區：${locale.label}\n- 人設話題種子：${targetTopics.join("、")}\n- 只採用與人設或使用者本次主題高度相關的熱點；無關時不要硬套\n- 吸收事件事實、受眾痛點與討論角度，改寫為人設本人的自然觀察，禁止照抄標題或捏造細節`,
      ].join("\n\n")
    : buildFallbackIntel(targetTopics, locale);

  cache[cacheKey] = { updatedAt: new Date().toISOString(), text };
  writeCache(cache);
  return text;
}
