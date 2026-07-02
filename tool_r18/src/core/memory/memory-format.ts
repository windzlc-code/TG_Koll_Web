export const OUTLINE_MAX_LEN = 108;
const THUMBNAIL_MAX_LEN = 72;
const TRUNCATION_MARK = "...";
const TRAILING_SEPARATOR_RE = /[，,、；;：:。.!！?？\s]+$/;
const STRUCTURED_OUTLINE_RE = /(主題|觀點|重點|關鍵|建議|結論|後續)[:：]/;
const MODEL_SCRATCH_RE = /\b(?:Initiating the Analysis|Defining the Objective|Defining the Goal|Defining the Structure|Refining the Output|Checking Requirements|I've zeroed in|I'm currently dissecting|I'?m currently|Okay,\s*I'?m|The core challenge|long-term memory summary|specific persona|output language|approximately\s+\d+[^；;。.!！?？]*?\bwords|fitting the persona|word count|I've also verifie|I need to|The user wants|Now I need|Let'?s craft)\b/i;
const NUMBER_RE = /[\d０-９]+(?:[.,]\d+)?\s*(?:年|月|日|週|天|%|％|元|萬|億|K|k|倍|折|歲)?/;
const OPINION_RE = /(觀點|認為|覺得|有感|重點|關鍵|問題|風險|機會|趨勢|根本|其實|不是|而是|回不去|撐不住|最好的時機|值得|不值得|核心)/;
const ADVICE_RE = /(建議|可以|應該|必須|需要|記得|先|不如|與其|最好|不要|別|開始|整理|配置|檢查|留意|避開|建立|保留|降低|提高)/;
const ACTION_LEAD_RE = /^(建議|可以|應該|必須|需要|記得|先|不如|與其|最好|不要|別|開始|整理|配置|檢查|留意|避開|建立|保留|降低|提高)/;
const DETAIL_KEYWORDS = [
  "資產配置", "現金流", "保險缺口", "緊急預備金", "生活成本", "健保費", "便當",
  "理財", "投資", "退休", "房貸", "租金", "利率", "通膨", "物價", "薪資",
  "收入", "支出", "風險", "市場", "政策", "客戶", "品牌", "平台", "流量",
  "轉換", "素材", "內容", "廣告", "門市", "產品", "服務", "AI", "模型",
  "數據", "效率", "成本", "家庭", "中產", "上班族", "媽媽", "孩子", "職場",
  "醫療", "稅務", "ETF", "股票", "債券", "美元", "台幣", "臺幣", "新台幣",
  "庶民生活", "手搖飲", "鮮奶茶", "客單價", "回購頻率",
];

export interface MemoryEntryPreview {
  id?: string | number;
  date: string;
  summary: string;
  content?: string;
}

export interface ArchiveMemoryPostLike {
  id?: string | number;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

function stripMarkdownAndEmoji(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\r\n]+/g, "；")
    .replace(/(?:\*\*)?(?:Initiating the Analysis|Defining the Objective|Defining the Goal|Defining the Structure|Refining the Output|Checking Requirements)(?:\*\*)?/gi, "；")
    .replace(/approximately\s+\d+[^；;。.!！?？]*?\bwords/gi, "；")
    .replace(/fitting the persona/gi, "；")
    .replace(/word count/gi, "；")
    .replace(/[#>*_`~()[\][]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/(.{2,16})\1{2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isModelScratchFragment(fragment: string): boolean {
  const normalized = normalizeFragment(fragment);
  if (!normalized) return true;
  if (MODEL_SCRATCH_RE.test(normalized)) return true;
  const asciiLetters = normalized.match(/[A-Za-z]/g)?.length || 0;
  const cjk = normalized.match(/[\u3400-\u9FFF]/g)?.length || 0;
  if (asciiLetters >= 18 && cjk === 0) return true;
  if (/^(Okay|I'?m|I am|The|Now|Let'?s|First|Next|Finally)\b/i.test(normalized) && asciiLetters > cjk) return true;
  return false;
}

function trimOutline(text: string): string {
  let outline = text
    .replace(/\s*([；;。.!！?？，,、：:])\s*/g, "$1")
    .replace(/(?:^|[；;。.!！?？])(?:主題|觀點|重點|關鍵|建議|結論|後續|補充)[:：](?=$|[；;。.!！?？])/g, "")
    .replace(/(?:[；;。.!！?？])?(?:主題|觀點|重點|關鍵|建議|結論|後續|補充)[:：]$/g, "")
    .replace(/[。.!！?？\s]+$/, "")
    .trim();
  if (outline.length > OUTLINE_MAX_LEN) {
    outline = truncateAtBoundary(outline, OUTLINE_MAX_LEN);
  }
  return outline;
}

function truncateAtBoundary(text: string, maxLen: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxLen) return normalized;

  const head = normalized.slice(0, maxLen);
  const minStrongBoundary = Math.floor(maxLen * 0.55);
  const strongBoundary = Math.max(
    head.lastIndexOf("；"),
    head.lastIndexOf(";"),
    head.lastIndexOf("。"),
    head.lastIndexOf("！"),
    head.lastIndexOf("!"),
    head.lastIndexOf("？"),
    head.lastIndexOf("?"),
  );
  if (strongBoundary >= minStrongBoundary) {
    return `${head.slice(0, strongBoundary + 1).replace(TRAILING_SEPARATOR_RE, "").trim()}${TRUNCATION_MARK}`;
  }

  const minWeakBoundary = Math.floor(maxLen * 0.7);
  const weakBoundary = Math.max(
    head.lastIndexOf("，"),
    head.lastIndexOf(","),
    head.lastIndexOf("、"),
  );
  if (weakBoundary >= minWeakBoundary) {
    return `${head.slice(0, weakBoundary).replace(TRAILING_SEPARATOR_RE, "").trim()}${TRUNCATION_MARK}`;
  }

  return `${head.replace(TRAILING_SEPARATOR_RE, "").trim()}${TRUNCATION_MARK}`;
}

function splitMemoryFragments(text: string): string[] {
  return stripMarkdownAndEmoji(text)
    .split(/[。！？!?；;\r\n]+|[，,]/)
    .map((item) => normalizeFragment(item))
    .filter((item) => !isModelScratchFragment(item))
    .filter(Boolean);
}

function normalizeFragment(fragment: string): string {
  return fragment
    .replace(/^[\s\-•·、，。]+/, "")
    .replace(/^\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?\s*/u, "")
    .replace(/^(最近|今天|這幾天|剛剛|其實|欸說真的|欸|說真的|老實說|我發現|我看到|看到|滑到|聽到|讀到|專家提到|專家說|有朋友問我|很多人問我)[，,：:\s]*/u, "")
    .replace(/^(我只能說|我想說|簡單講|簡單說)[：:\s]*/u, "")
    .replace(/(我超有感觸|真的很有感|超有感|很有感)$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fragmentKey(fragment: string): string {
  return fragment.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 28);
}

function keywordScore(fragment: string): number {
  return DETAIL_KEYWORDS.reduce((score, keyword) => score + (fragment.includes(keyword) ? 1 : 0), 0);
}

function scoreFragment(fragment: string, index: number): number {
  let score = 0;
  if (NUMBER_RE.test(fragment)) score += 4;
  if (OPINION_RE.test(fragment)) score += 3;
  if (ADVICE_RE.test(fragment)) score += 3;
  score += Math.min(keywordScore(fragment), 5) * 2;
  if (fragment.length >= 8) score += 1;
  if (fragment.length > 70) score -= 2;
  return score - index * 0.05;
}

function pickFragment(
  fragments: string[],
  used: Set<string>,
  predicate?: (fragment: string) => boolean,
): string {
  const candidates = fragments
    .map((fragment, index) => ({
      fragment,
      key: fragmentKey(fragment),
      score: scoreFragment(fragment, index) + (predicate?.(fragment) ? 8 : 0),
      matches: predicate ? predicate(fragment) : true,
    }))
    .filter((item) => item.key.length >= 4 && !used.has(item.key) && item.matches)
    .sort((a, b) => b.score - a.score);

  const picked = candidates[0]?.fragment || "";
  if (picked) used.add(fragmentKey(picked));
  return picked;
}

function pickKeyPoints(fragments: string[], used: Set<string>, count = 2): string[] {
  const picked: string[] = [];
  const candidates = fragments
    .map((fragment, index) => ({
      fragment,
      key: fragmentKey(fragment),
      score: scoreFragment(fragment, index)
        + Math.min(keywordScore(fragment), 4) * 2
        + (NUMBER_RE.test(fragment) ? 3 : 0)
        - (ADVICE_RE.test(fragment) ? 4 : 0),
    }))
    .filter((item) => item.key.length >= 4 && !used.has(item.key) && item.score >= 2.5)
    .sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (picked.some((item) => {
      const key = fragmentKey(item);
      return key.includes(candidate.key) || candidate.key.includes(key);
    })) {
      continue;
    }
    picked.push(candidate.fragment);
    used.add(candidate.key);
    if (picked.length >= count) break;
  }
  return picked;
}

export function buildMemoryOutline(text: string): string {
  const cleaned = stripMarkdownAndEmoji(text);
  if (!cleaned) return "";
  if (STRUCTURED_OUTLINE_RE.test(cleaned)) {
    const topic = pickStructuredSection(cleaned, ["主題", "關鍵", "結論"]);
    const point = pickStructuredSection(cleaned, ["建議", "重點", "觀點", "後續"]);
    const compact = [
      topic ? `主題：${topic}` : "",
      point && point !== topic ? `重點：${point}` : "",
    ].filter(Boolean).join("；");
    return trimOutline(compact || cleaned);
  }

  const fragments = splitMemoryFragments(cleaned);
  if (fragments.length === 0) return trimOutline(cleaned);
  if (fragments.length === 1 && fragments[0].length <= 32) return trimOutline(fragments[0]);

  const used = new Set<string>();
  const topic = pickFragment(fragments, used, (fragment) => !ACTION_LEAD_RE.test(fragment) && (NUMBER_RE.test(fragment) || keywordScore(fragment) > 0))
    || pickFragment(fragments, used);
  const opinion = pickFragment(fragments, used, (fragment) => OPINION_RE.test(fragment) && !/^(而不是|不是只)/u.test(fragment));
  const advice = pickFragment(fragments, used, (fragment) => ADVICE_RE.test(fragment));
  const keyPoints = pickKeyPoints(fragments, used, 2);

  const sections = [
    topic ? `主題：${topic}` : "",
    opinion ? `觀點：${opinion}` : "",
    advice ? `建議：${advice}` : "",
    keyPoints.length ? `重點：${keyPoints.join("、")}` : "",
  ].filter(Boolean);

  return trimOutline(sections.length ? sections.join("；") : fragments.slice(0, 3).join("；"));
}

function compactMemoryFragment(text: string, maxLen = 72): string {
  const normalized = normalizeFragment(text)
    .replace(/^(主題|觀點|重點|建議|關鍵|結論|後續)[:：]/, "")
    .trim();
  if (!normalized || isModelScratchFragment(normalized)) return "";
  if (normalized.length <= maxLen) return normalized;
  return truncateAtBoundary(normalized, maxLen);
}

function pickStructuredSection(outline: string, labels: string[]): string {
  for (const label of labels) {
    const match = outline.match(new RegExp(`${label}[:：]([^；;]+)`));
    if (match?.[1]) return compactMemoryFragment(match[1]);
  }
  return "";
}

function compactThumbnailPart(text: string): string {
  return compactMemoryFragment(text, 44)
    .replace(/^專家對\s*/u, "")
    .replace(/的建議$/u, "")
    .replace(/^現在一個/u, "")
    .replace(/隨便都要/u, "")
    .replace(/可能又要/u, "可能調")
    .replace(/^如果你還在猶豫要不要/u, "")
    .replace(/^與其去研究那些聽不懂的複雜商品/u, "")
    .replace(/^不如先把/u, "")
    .replace(/^建議/u, "")
    .replace(/^反映/u, "")
    .replace(/整理好$/u, "")
    .replace(/的壓力$/u, "壓力")
    .replace(TRAILING_SEPARATOR_RE, "")
    .trim();
}

function joinThumbnailPieces(pieces: string[]): string {
  return trimOutline(pieces.filter(Boolean).join("；"));
}

export function buildMemoryThumbnail(text: string): string {
  const cleaned = stripMarkdownAndEmoji(text);
  const outline = STRUCTURED_OUTLINE_RE.test(cleaned) ? trimOutline(cleaned) : buildMemoryOutline(text);
  if (!outline) return "";

  const topic = compactThumbnailPart(pickStructuredSection(outline, ["主題"]));
  const impact = compactThumbnailPart(pickStructuredSection(outline, ["觀點", "重點", "關鍵"]));
  const advice = compactThumbnailPart(pickStructuredSection(outline, ["建議"]));
  const topicPiece = topic ? `主題：${topic}` : "";
  const impactPiece = impact ? `${topic ? "重點" : "主題"}：${impact}` : "";
  const advicePiece = advice && advice !== impact ? `建議：${advice}` : "";
  const candidateGroups = [
    [topicPiece, impactPiece, advicePiece],
    [topicPiece, impactPiece],
    [topicPiece, advicePiece],
    [topicPiece],
    [impactPiece, advicePiece],
  ];

  let compact = "";
  for (const group of candidateGroups) {
    const candidate = joinThumbnailPieces(group);
    if (candidate && candidate.length <= THUMBNAIL_MAX_LEN) {
      compact = candidate;
      break;
    }
  }
  if (!compact) {
    compact = joinThumbnailPieces([topicPiece, impactPiece, advicePiece]) || outline;
  }
  if (compact.length > THUMBNAIL_MAX_LEN) {
    const topicOnly = topicPiece && topicPiece.length <= THUMBNAIL_MAX_LEN ? topicPiece : "";
    compact = topicOnly || truncateAtBoundary(compact, THUMBNAIL_MAX_LEN);
  }
  return compact;
}

export function normalizeMemorySummaryForStorage(text: string): string {
  const compact = buildMemoryThumbnail(text) || buildMemoryOutline(text);
  return trimOutline(compact);
}

export function buildArchivePostMemoryEntries(posts: ArchiveMemoryPostLike[] = []): MemoryEntryPreview[] {
  return posts
    .map((post, index) => {
      const summary = buildMemoryThumbnail(post.content || "");
      if (!summary) return null;
      return {
        id: post.id ?? index,
        date: post.updatedAt || post.createdAt || "",
        summary,
        content: undefined,
      };
    })
    .filter(Boolean) as MemoryEntryPreview[];
}

export function formatMemoryEntriesForPrompt(entries: MemoryEntryPreview[], limit = 12): string {
  if (!entries.length) return "";
  return entries
    .slice(0, limit)
    .map((entry) => {
      const dateLabel = entry.date ? entry.date.slice(0, 10) : "未紀錄日期";
      return `[${dateLabel}] ${entry.summary}`;
    })
    .join("\n");
}
