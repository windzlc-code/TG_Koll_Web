import { buildMemoryOutline, normalizeMemorySummaryForStorage, OUTLINE_MAX_LEN, type MemoryEntryPreview } from "@/core/memory/memory-format";
import {
  callTextUnderstandingModelWithFallback,
  explainGeminiNoText,
  extractText,
  getProtocolEndpoint,
  isTextModelFallbackError,
} from "@/lib/gemini-client";

const MEMORY_TEXT_MODEL = "xai/grok-4.3";
const CONSOLIDATED_MEMORY_MAX_LEN = 700;

function isTestRuntime(): boolean {
  if (process.env.PERSONA_MEMORY_AI_TEST === "1") return false;
  return Boolean(process.env.VITEST || process.env.NODE_ENV === "test");
}

function cleanSummary(text: string, maxLen = OUTLINE_MAX_LEN): string {
  const cleaned = text
    .replace(/^["'`“”‘’\s]+|["'`“”‘’\s]+$/g, "")
    .replace(/^(摘要|記憶|memory|summary)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen).replace(/[，,、；;：:\s]+$/g, "")}...`;
}

function ensureUsefulPostSummary(summary: string, original: string): string {
  const cleaned = cleanSummary(summary, OUTLINE_MAX_LEN);
  if (cleaned) return cleaned;
  return normalizeMemorySummaryForStorage(original);
}

async function callMemoryModel(prompt: string, maxOutputTokens = 512): Promise<string> {
  const endpoint = getProtocolEndpoint("openai");
  if (!endpoint.apiKey || isTestRuntime()) return "";
  const result = await callTextUnderstandingModelWithFallback(
    MEMORY_TEXT_MODEL,
    [{ role: "user", parts: [{ text: prompt }] }],
    {
      maxOutputTokens,
      temperature: 0.2,
    },
    undefined,
    {
      isUsableResponse: (data) => Boolean(extractText(data).trim()),
      isRetryableError: isTextModelFallbackError,
    },
  );
  const json = result.data;
  const text = extractText(json).trim();
  if (!text) {
    throw new Error(explainGeminiNoText(json) || `${MEMORY_TEXT_MODEL} 返回空記憶摘要`);
  }
  return text;
}

export async function summarizePersonaPostMemory(input: {
  personaName?: string;
  personaContent?: string;
  postContent: string;
  sequenceNumber?: number;
}): Promise<string> {
  const fallback = buildMemoryOutline(input.postContent);
  const prompt = [
    "請把下面這篇已生成或已發布的社群推文壓縮成人設長期記憶（核心摘要）。",
    "",
    "要求：",
    `- 只輸出一條記憶摘要，最多 ${OUTLINE_MAX_LEN} 個中文字符。`,
    "- 只保留日後創作最有用的核心事實：人物關係、地點、時間、具體事件、情緒轉折、承諾、伏筆、重要偏好或數字。",
    "- 如果只是新聞評論/日常觀點，提煉成一個可延續的人設立場，不要保留整段推文。",
    "- 刪掉開場白、口水話、hashtags、AI 分析過程、字數/語氣要求、英文 scratch text。",
    "- 不要逐字保留原文，不要輸出標題，不要加條列。",
    "",
    `人設：${input.personaName || "未命名人設"}`,
    input.sequenceNumber ? `本篇序號：第 ${input.sequenceNumber} 篇` : "",
    input.personaContent ? `人設簡介：${input.personaContent.slice(0, 800)}` : "",
    "",
    "推文正文：",
    input.postContent,
  ].filter(Boolean).join("\n");

  try {
    const rawSummary = await callMemoryModel(prompt);
    if (!rawSummary.trim()) return fallback;
    const summary = ensureUsefulPostSummary(rawSummary, input.postContent);
    return summary || fallback;
  } catch {
    return fallback;
  }
}

export async function consolidatePersonaMemoryEntries(input: {
  personaName?: string;
  personaContent?: string;
  entries: MemoryEntryPreview[];
}): Promise<string> {
  const joined = input.entries
    .map((entry) => `[${entry.date?.slice(0, 10) || "未紀錄日期"}] ${entry.summary}`)
    .join("\n");
  const fallback = cleanSummary(normalizeMemorySummaryForStorage(buildMemoryOutline(joined)), CONSOLIDATED_MEMORY_MAX_LEN);
  const prompt = [
    "請把下面 60 天以前的人設推文記憶整合成長期背景記憶。",
    "",
    "要求：",
    `- 最多 ${CONSOLIDATED_MEMORY_MAX_LEN} 個中文字符。`,
    "- 保留可長期引用的關鍵事實：連續事件、人物關係、地點、時間線、重要數字、旅行/工作/家庭/情感經歷。",
    "- 合併重複內容，刪掉新聞流水帳、口水話、推文原句、AI 分析過程與無法支持後續創作的描述。",
    "- 只輸出整合後記憶正文，不要標題和條列。",
    "",
    `人設：${input.personaName || "未命名人設"}`,
    input.personaContent ? `人設簡介：${input.personaContent.slice(0, 800)}` : "",
    "",
    joined,
  ].filter(Boolean).join("\n");

  try {
    const summary = cleanSummary(normalizeMemorySummaryForStorage(await callMemoryModel(prompt, 900)), CONSOLIDATED_MEMORY_MAX_LEN);
    return summary || fallback;
  } catch {
    return fallback;
  }
}
