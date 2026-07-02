/**
 * src/lib/news-fetcher.ts
 * Fetches trending topics via Electron's hidden BrowserWindow.
 * - Multi-source search per market
 * - Daily cache per persona+genre (localStorage)
 */

const newsAPI = () => (window as any).electronAPI?.news;

const CACHE_PREFIX = "news_cache_v2_";
const LATEST_INTEL_PREFIX = "news_latest_intel_v1_";
type TrendIntelMode = "all" | "news" | "social" | "slang";
type FetchTrendingOptions = {
  bypassCache?: boolean;
  fetchTimeoutMs?: number;
  maxConcurrency?: number;
};

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isToday(value?: string): boolean {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return localDateKey(date) === localDateKey();
}

function normalizeTrendSeed(seed: string): string {
  return seed
    .replace(/(創作者|专家|專家|達人|老师|老師|規劃師|咨询师|諮詢師|主妇|主婦|媽媽|爸爸|創作)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function todayKey(personaId: string, genre: string): string {
  const date = localDateKey();
  return `${CACHE_PREFIX}${personaId}_${genre}_${date}`;
}

function getCached(personaId: string, genre: string): string | null {
  try {
    const raw = localStorage.getItem(todayKey(personaId, genre));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setCache(personaId: string, genre: string, text: string): void {
  try {
    localStorage.setItem(todayKey(personaId, genre), JSON.stringify(text));
    // Clean up old cache entries (keep only today's)
    const today = localDateKey();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX) && !key.includes(today)) {
        localStorage.removeItem(key);
      }
    }
  } catch { /* ignore quota errors */ }
}

function setLatestIntelCache(personaId: string, text: string): void {
  try {
    localStorage.setItem(`${LATEST_INTEL_PREFIX}${personaId}`, JSON.stringify({
      text,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // ignore storage issues
  }
}

export function getLatestTrendIntel(personaId?: string): { text: string; updatedAt: string } | null {
  if (!personaId) return null;
  try {
    const raw = localStorage.getItem(`${LATEST_INTEL_PREFIX}${personaId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text !== "string") return null;
    return {
      text: parsed.text,
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function getTodayTrendIntel(personaId?: string): { text: string; updatedAt: string } | null {
  const intel = getLatestTrendIntel(personaId);
  if (!intel || !isToday(intel.updatedAt)) return null;
  return intel;
}

async function fetchOnce(
  query: string,
  market: string,
  mode: TrendIntelMode = "all",
  localeKey?: string,
  timeoutMs?: number,
): Promise<string> {
  const api = newsAPI();
  if (!api) return "";
  try {
    const result = await api.fetch({ query, market, mode, localeKey, timeoutMs });
    if (result?.ok && result.text) return result.text;
    if (result && !result.ok) {
      console.warn("[news-fetcher] empty result", { query, market, mode, localeKey, result });
    }
  } catch (error) {
    console.warn("[news-fetcher] fetch failed", { query, market, mode, localeKey, error });
  }
  return "";
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex]);
    }
  });
  await Promise.all(runners);
}

/**
 * Fetch trending topics for a persona.
 * Uses daily cache — if already fetched today for this persona+genre, returns cached result.
 * For composite personas (2 genres), fetches each separately + combined.
 * Saves results to persona memory.
 */
export async function fetchTrendingTopics(
  genres: string[],
  market: string,
  personaId?: string,
  personaName?: string,
  onProgress?: (msg: string) => void,
  localeKey?: string,
  options?: FetchTrendingOptions,
): Promise<string> {
  if (!genres || genres.length === 0) return "";

  if (personaId && !options?.bypassCache) {
    const todayIntel = getTodayTrendIntel(personaId);
    if (todayIntel?.text) {
      onProgress?.("今日已有人設資訊快取 ✓");
      return todayIntel.text;
    }
  }

  const year = new Date().getFullYear();
  const normalizedGenres = genres.map(normalizeTrendSeed).filter(Boolean);
  const suffix: Record<string, string> = {
    cn: ` 熱門話題 最新 ${year}`,
    jp: ` トレンド 最新 ${year}`,
    west: ` trending topics ${year}`,
    kr: ` 트렌드 최신 ${year}`,
    sea: ` trending topics ${year}`,
  };
  const sfx = suffix[market] || suffix.cn;

  const queriesToFetch: Array<{ label: string; q: string }> = normalizedGenres.length === 1
    ? [{ label: genres[0], q: normalizedGenres[0] + sfx }]
    : [
        { label: genres[0], q: normalizedGenres[0] + sfx },
        { label: genres[1], q: normalizedGenres[1] + sfx },
        { label: `${genres[0]} × ${genres[1]}`, q: `${normalizedGenres[0]} ${normalizedGenres[1]}${sfx}` },
      ];

  const results: string[] = [];
  const modeLabels: Array<{ mode: TrendIntelMode; title: string }> = [
    { mode: "news", title: "新聞與趨勢" },
    { mode: "social", title: "社媒討論" },
    { mode: "slang", title: "地區熱梗 / 網路語料" },
  ];
  const timeoutMs = Math.max(2500, options?.fetchTimeoutMs ?? 6500);
  const maxConcurrency = Math.max(1, options?.maxConcurrency ?? 3);
  const sectionResults = new Map<string, Map<TrendIntelMode, string>>();
  const tasks: Array<{
    label: string;
    query: string;
    mode: TrendIntelMode;
    title: string;
  }> = [];

  for (const { label, q } of queriesToFetch) {
    const cached = personaId && !options?.bypassCache ? getCached(personaId, label) : null;

    if (cached) {
      onProgress?.(`「${label}」今日已快取 ✓`);
      results.push(`=== ${label} ===\n${cached}`);
      continue;
    }

    for (const section of modeLabels) {
      tasks.push({
        label,
        query: section.mode === "social" ? normalizeTrendSeed(label) : q,
        mode: section.mode,
        title: section.title,
      });
    }
  }

  await runWithConcurrency(tasks, maxConcurrency, async (task) => {
    onProgress?.(`正在搜尋「${task.label}」${task.title}…`);
    const text = await fetchOnce(task.query, market, task.mode, localeKey, timeoutMs);
    if (!text) return;
    const bucket = sectionResults.get(task.label) || new Map<TrendIntelMode, string>();
    bucket.set(task.mode, text);
    sectionResults.set(task.label, bucket);
  });

  for (const { label } of queriesToFetch) {
    if (results.some((item) => item.startsWith(`=== ${label} ===\n`))) continue;
    const bucket = sectionResults.get(label);
    if (!bucket) continue;
    const text = modeLabels
      .map((section) => {
        const sectionText = bucket.get(section.mode);
        return sectionText ? `【${section.title}】\n${sectionText}` : "";
      })
      .filter(Boolean)
      .join("\n\n");

    if (text) {
      if (personaId) setCache(personaId, label, text);

      results.push(`=== ${label} ===\n${text}`);
    }
  }

  const combined = results.join("\n\n") || buildFallbackTrendIntel(genres, market, localeKey);
  if (personaId && combined) {
    setLatestIntelCache(personaId, combined);
  }
  return combined;
}

function buildFallbackTrendIntel(genres: string[], market: string, localeKey?: string): string {
  const region = localeKey || market || "cn";
  const topicLine = genres.filter(Boolean).join("、") || "日常生活";
  const localFlavor = /tw|cn_tw/i.test(region)
    ? "台灣社群語氣、Threads/Dcard 式生活吐槽、通勤與吃喝日常"
    : /hk|cn_hk/i.test(region)
      ? "香港社群語氣、LIHKG/Threads 式吐槽、都會生活細節"
      : /jp/i.test(region)
        ? "日本社群語氣、X/Instagram 式短句、季節感與街頭日常"
        : "社群短帖語氣、生活化吐槽、在地日常細節";

  return [
    "【本地兜底舆情摘要】",
    `主題方向：${topicLine}`,
    `在地語感：${localFlavor}`,
    "可用切角：把熱門話題壓成個人生活小事故、反差萌、尷尬瞬間、朋友會留言的社群梗。",
    "內容提醒：避免像新聞摘要；優先寫成剛發生、剛拍照、剛想吐槽的私人貼文。",
  ].join("\n");
}

/** Build display label for the search status */
export function buildSearchLabel(genres: string[]): string {
  if (!genres || genres.length === 0) return "";
  return genres.join(" + ");
}
