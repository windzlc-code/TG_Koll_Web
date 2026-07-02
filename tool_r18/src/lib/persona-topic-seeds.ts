import type { DramaSetup } from "@/types/drama";

const GENERIC_TOPIC_STOPWORDS = new Set([
  "人設",
  "創作者",
  "內容",
  "檔案",
  "故事",
  "日常",
  "分享",
  "紀錄",
  "instagram",
  "threads",
  "verify",
  "final",
  "fast",
  "archive",
  "社群",
  "互動",
  "社群互動",
  "生活",
  "女生",
  "男生",
]);

function normalizeSeed(seed: string): string {
  return seed
    .replace(/[《》「」【】()（）:：]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitThemePhrases(text: string): string[] {
  return text
    .split(/[、，,\/|；;\n]/)
    .map((part) => normalizeSeed(part))
    .filter((part) => part.length >= 2 && part.length <= 16);
}

function tokenizeTerms(text: string): string[] {
  return (normalizeSeed(text).match(/[\u4e00-\u9fa5]{2,8}|[a-zA-Z]{3,24}/g) || [])
    .map((term) => term.trim())
    .filter(Boolean);
}

function buildBlockedNameTerms(setup: DramaSetup, archiveName?: string): Set<string> {
  const blocked = new Set<string>();
  for (const source of [archiveName, setup.personaName]) {
    const value = normalizeSeed(String(source || ""));
    if (!value) continue;
    blocked.add(value.toLowerCase());
    for (const term of tokenizeTerms(value)) {
      blocked.add(term.toLowerCase());
    }
  }
  return blocked;
}

function shouldKeepSeed(seed: string, blockedNames: Set<string>): boolean {
  const normalized = normalizeSeed(seed);
  if (normalized.length < 2) return false;
  const lowered = normalized.toLowerCase();
  if (blockedNames.has(lowered)) return false;
  if (GENERIC_TOPIC_STOPWORDS.has(lowered)) return false;
  return true;
}

export function derivePersonaTopicSeeds(
  setup: DramaSetup,
  archiveName?: string,
  characters = "",
  instruction = "",
): string[] {
  const explicitTrendTopics = (setup.trendTopics || [])
    .map((topic) => normalizeSeed(String(topic || "")))
    .filter(Boolean);
  if (explicitTrendTopics.length > 0) {
    return [...new Set(explicitTrendTopics)].slice(0, 3);
  }

  const explicitGenres = (setup.genres || []).map((genre) => String(genre || "").trim()).filter(Boolean);
  if (explicitGenres.length > 0) {
    return explicitGenres;
  }

  const blockedNames = buildBlockedNameTerms(setup, archiveName);
  const prioritized = [
    ...splitThemePhrases(setup.contentTheme || ""),
    ...splitThemePhrases(instruction || ""),
    ...splitThemePhrases(setup.personaDescription || ""),
    ...tokenizeTerms([setup.contentTheme, instruction, setup.personaDescription, characters].filter(Boolean).join(" ")),
  ];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const term of prioritized) {
    const normalized = normalizeSeed(term);
    const key = normalized.toLowerCase();
    if (!shouldKeepSeed(normalized, blockedNames)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(0, 3);
}
