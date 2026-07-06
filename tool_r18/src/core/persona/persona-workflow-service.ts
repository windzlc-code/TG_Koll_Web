import { createPersonaArchive, listPersonaArchives, loadPersonaArchive, appendEpisodesToArchive, updatePersonaArchiveProfile, deletePersonaArchive, getArchivePendingPostsForPlatform } from "@/lib/persona-archives";
import { markArchiveEpisodesPublished } from "@/lib/persona-archives";
import { buildSocialPostsPrompt } from "@/lib/drama-prompts";
import { callTextUnderstandingModelWithFallback, explainGeminiNoText, extractText, isTextModelFallbackError } from "@/lib/gemini-client";
import { createNodePublishQueueRepository } from "@/runtime/node/publish-queue-repository";
import { parseGeneratedPosts } from "@/core/persona/generated-post-parser";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import {
  buildMemoryOutline,
  formatMemoryEntriesForPrompt,
  getMemoryEntries,
  normalizeMemorySummaryForStorage,
  summarizePostForMemory,
  type MemoryEntryPreview,
} from "@/lib/persona-memory-v2";
import { fetchPersonaTrendIntelForNode } from "@/lib/persona-trend-intel-node";
import { readRuntimeApiConfig } from "@/runtime/node/config";
import fs from "node:fs";
import type { DramaSetup, EpisodeScript } from "@/types/drama";

const PERSONA_TEXT_MODEL = "xai/grok-4.3";
const PERSONA_TEXT_MAX_RETRIES = 3;
type PersonaTextModelBranch = "free";

function resolvePersonaTextModelPreference(): string {
  const config = readRuntimeApiConfig() as Record<string, unknown>;
  const configured = [
    config.llmFreeModelPriorityOrder,
    config.llm_free_model_priority_order,
    config.llmModelPriorityOrder,
    config.llm_model_priority_order,
    config.llmDefaultModelGpt,
    config.llm_default_model_gpt,
    config.llmDefaultModel,
    config.llm_default_model,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  return configured || PERSONA_TEXT_MODEL;
}

function memorySummaryForPrompt(summary: string): string {
  const raw = String(summary || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= 140 && !/\b(?:Defining the Objective|Initiating the Analysis|word count|fitting the persona)\b/i.test(raw)) {
    return raw;
  }
  return normalizeMemorySummaryForStorage(raw);
}

function buildTweetStyleInstruction(setup: any): string {
  const profile = String(setup?.tweetStyleProfile || "").trim();
  if (!profile) return "";
  return [
    "【固定推文风格】",
    "该人设已设置专属推文风格。生成时只能模仿格式结构、内容推进方式、语气和互动钩子；禁止复述示例里的具体事件、事实、人物、福利话术或连续原句。",
    profile ? `风格分析：${profile}` : "",
    "必须使用当前人设、记忆和用户提示生成全新内容；如果没有明确主题，就换一个同人设的日常观点或互动主题，不要沿用示例主题。",
  ].filter(Boolean).join("\n");
}

function resolveActiveLinkEndingPreset(setup: any): { linkUrl: string; endingText: string } | null {
  const presets = Array.isArray(setup?.linkEndingPresets) ? setup.linkEndingPresets : [];
  const activeId = String(setup?.activeLinkEndingPresetId || "").trim();
  const active = presets.find((preset: any) =>
    preset
    && preset.enabled !== false
    && String(preset.id || "").trim()
    && (!activeId || String(preset.id || "").trim() === activeId));
  if (active) {
    const linkUrl = String(active.linkUrl || "").trim();
    const endingText = String(active.endingText || "").trim();
    return linkUrl || endingText ? { linkUrl, endingText } : null;
  }
  const legacyLinkUrl = String(setup?.tweetStyleLinkUrl || "").trim();
  const legacyEndingText = String(setup?.tweetStyleLinkText || "").trim();
  return legacyLinkUrl || legacyEndingText ? { linkUrl: legacyLinkUrl, endingText: legacyEndingText } : null;
}

function buildLinkEndingInstruction(setup: any): string {
  const preset = resolveActiveLinkEndingPreset(setup);
  if (!preset) return "";
  return [
    "【固定链接结尾】",
    "该人设已开启链接结尾预设。每篇生成推文结尾必须自动追加以下结尾语句或链接，不要改写，不要省略。",
    preset.endingText ? `结尾语句：${preset.endingText}` : "",
    preset.linkUrl ? `固定链接：${preset.linkUrl}` : "",
    preset.linkUrl ? "The fixed link must appear exactly once and must be the final line of the post." : "",
    "正文可以按人设和主题自由生成，但不要在固定结尾之后再添加任何文字、标点、表情或标签。",
  ].filter(Boolean).join("\n");
}

function buildChineseScriptInstruction(archive: { id?: string; setup?: any }): string {
  void archive;
  return [
    "【Traditional Chinese output rule】",
    "1. Final post body must be generated directly in Traditional Chinese.",
    "2. Use natural Taiwan social-media wording; do not output Simplified Chinese.",
    "3. If persona data, memories, trends, or user input contain Simplified Chinese, only use them for meaning and rewrite the final post in Traditional Chinese.",
  ].join("\n");
}

function isJinjunyaLinkPersona(setup: any): boolean {
  const markers = [
    String(setup?.personaName || ""),
  ].join(" ").toLowerCase();
  return markers.includes("\u91d1\u541b\u96c5") || markers.includes("jinjunya");
}


function escapeRegExpText(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moveTweetStyleLinkToEnd(content: string, linkUrl: string) {
  const raw = String(content || "").trim();
  const link = String(linkUrl || "").trim();
  if (!raw || !link) return raw;
  const withoutLink = raw
    .replace(new RegExp(escapeRegExpText(link), "g"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${withoutLink}\n${link}`.trim();
}

function applyLinkEndingPresetToContent(content: string, preset: { linkUrl: string; endingText: string }): string {
  let next = String(content || "").trim();
  const endingText = String(preset.endingText || "").trim();
  const linkUrl = String(preset.linkUrl || "").trim();
  if (endingText) {
    next = next
      .replace(new RegExp(escapeRegExpText(endingText), "g"), "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    next = `${next}\n${endingText}`.trim();
  }
  if (linkUrl) next = moveTweetStyleLinkToEnd(next, linkUrl);
  return next.trim();
}

function ensurePostsContainLinkEndingPreset(posts: EpisodeScript[], setup: any): EpisodeScript[] {
  const preset = resolveActiveLinkEndingPreset(setup);
  if (!preset) return posts;
  return posts.map((post) => {
    const nextContent = applyLinkEndingPresetToContent(String(post.content || ""), preset);
    return {
      ...post,
      content: nextContent,
      wordCount: nextContent.length,
    };
  });
}

function normalizeStyleComparisonText(text: string): string {
  return String(text || "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .toLowerCase();
}

function textBigramSet(text: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    set.add(text.slice(index, index + 2));
  }
  return set;
}

function isTooSimilarToTweetStyleSample(content: string, setup: any): boolean {
  const sample = normalizeStyleComparisonText(setup?.tweetStyleSample || "");
  const post = normalizeStyleComparisonText(content || "");
  if (sample.length < 20 || post.length < 20) return false;
  const sampleHead = sample.slice(0, Math.min(sample.length, 80));
  if (post.includes(sampleHead) || sample.includes(post.slice(0, Math.min(post.length, 80)))) return true;

  const sampleSet = textBigramSet(sample);
  const postSet = textBigramSet(post);
  if (!sampleSet.size || !postSet.size) return false;
  let overlap = 0;
  for (const item of postSet) {
    if (sampleSet.has(item)) overlap += 1;
  }
  return overlap / Math.min(sampleSet.size, postSet.size) >= 0.72;
}

export function planPersonaPostGenerationBatches(count: number, targetWords = 120): number[] {
  const total = Math.max(1, Math.min(20, Math.floor(Number.isFinite(count) ? count : 1)));
  const words = Math.max(0, Math.floor(Number.isFinite(targetWords) ? targetWords : 120));
  const batchSize = words >= 200 ? 1 : words >= 120 ? 3 : 5;
  const batches: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const size = Math.min(batchSize, remaining);
    batches.push(size);
    remaining -= size;
  }
  return batches;
}

function isRetryableTextGenerationError(error: unknown): boolean {
  return isTextModelFallbackError(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateTextWithGemini(prompt: string, count: number): Promise<string> {
  const finalPrompt = [
    prompt,
    "",
    "【强制输出规则】",
    `1. 必须输出完整的 ${count} 篇独立推文正文。`,
    "2. 每篇之间只能使用一行 --- 分隔。",
    "3. 不要输出思考过程，不要输出说明，不要输出检查结果，不要输出标题说明。",
    `4. 直接从第 1 篇正文开始写，写完第 ${count} 篇正文后立即结束。`,
    `5. 如果少于 ${count} 篇视为失败。`,
  ].join("\n");

  let json: any;
  for (let attempt = 0; attempt <= PERSONA_TEXT_MAX_RETRIES; attempt += 1) {
    try {
      const result = await callTextUnderstandingModelWithFallback(
        resolvePersonaTextModelPreference(),
        [{ role: "user", parts: [{ text: finalPrompt }] }],
        {
          maxOutputTokens: Math.max(4096, count * 1200),
          temperature: 0.7,
        },
        undefined,
        {
          isUsableResponse: (data) => Boolean(extractText(data).trim()),
          isRetryableError: isRetryableTextGenerationError,
        },
      );
      json = result.data;
      break;
    } catch (error) {
      if (attempt >= PERSONA_TEXT_MAX_RETRIES || !isRetryableTextGenerationError(error)) {
        throw error;
      }
      await delay(2500 * (attempt + 1));
    }
  }
  const content = extractText(json).trim();
  if (!content) {
    throw new Error(explainGeminiNoText(json) || `${PERSONA_TEXT_MODEL} 返回空内容`);
  }
  try {
    fs.writeFileSync(resolveRuntimeFile("last_persona_generation_raw.txt"), content, "utf-8");
  } catch {}
  return content;
}

function parsePosts(text: string, count: number): EpisodeScript[] {
  const parts = parseGeneratedPosts(text, count);

  return parts.map((content, index) => ({
    number: index + 1,
    title: `第${index + 1}篇`,
    content,
    wordCount: content.length,
    orderIndex: index,
  }));
}

async function attachMemorySummariesToPosts(
  posts: EpisodeScript[],
  archive: { name: string; content: string; posts: Array<{ content: string; memorySummary?: string }> },
  previousCount: number,
): Promise<EpisodeScript[]> {
  return Promise.all(posts.map(async (post, index) => {
    const summary = await summarizePostForMemory({
      personaName: archive.name,
      personaContent: archive.content,
      postContent: post.content,
      sequenceNumber: previousCount + index + 1,
    });
    return {
      ...post,
      memorySummary: summary || buildMemoryOutline(post.content),
    };
  }));
}

async function buildPersonaGenerationMemoryPrompt(
  archive: { id: string; setup?: any; posts: Array<{ content: string; createdAt?: string; updatedAt?: string; memorySummary?: string }> },
): Promise<{ memoryText: string; recentPosts: string[]; existingCount: number; persistedEntries: MemoryEntryPreview[] }> {
  const persistedEntries = (await getMemoryEntries(archive.id).catch(() => []))
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  const cleanPosts = archive.posts.filter((post) => !isTooSimilarToTweetStyleSample(post.content, archive.setup));
  const pendingEntries = cleanPosts
    .map((post, index) => ({
      id: `pending-${index}`,
      date: post.updatedAt || post.createdAt || new Date().toISOString(),
      summary: memorySummaryForPrompt(post.memorySummary || buildMemoryOutline(post.content)),
    }))
    .filter((entry) => entry.summary.trim());
  const memoryText = formatMemoryEntriesForPrompt([
    ...pendingEntries,
    ...persistedEntries,
  ], 32);
  return {
    memoryText,
    recentPosts: cleanPosts.slice(-6).map((post) => post.content),
    existingCount: persistedEntries.length + archive.posts.length,
    persistedEntries,
  };
}

function buildSelectedMemoryInstruction(entries: MemoryEntryPreview[]): string {
  const selected = entries
    .map((entry) => ({
      ...entry,
      summary: memorySummaryForPrompt(String(entry.content || entry.summary || "")),
    }))
    .filter((entry) => String(entry.summary || "").trim())
    .slice(0, 8);
  if (!selected.length) return "";
  return [
    "【本次用户勾选的人设记忆】",
    "以下记忆是用户本次主动选择的内容锚点，必须优先引导本轮推文主题。",
    ...selected.map((entry, index) => {
      const date = entry.date ? String(entry.date).slice(0, 10) : "未标注日期";
      return `${index + 1}. ${date}：${String(entry.summary).trim().slice(0, 110)}`;
    }),
    "",
    "生成要求：",
    "1. 每篇推文都要自然关联这些勾选记忆中的人物、地点、事件、情绪或后续变化。",
    "2. 不要生硬复述记忆原文，要写成该人设当下的新动态、新感受或后续延展。",
    "3. 如果用户另有提示词，以用户提示词和勾选记忆共同约束主题；两者冲突时优先保留勾选记忆中的核心事实。",
  ].join("\n");
}

export type PersonaWorkflowInput =
  | { action: "create"; name: string; content: string; setup: DramaSetup; ownerBotName?: string; boundTelegramChatId?: string }
  | { action: "list" }
  | { action: "get"; archiveId: string }
  | { action: "update"; archiveId: string; name?: string; content?: string; setup?: Partial<DramaSetup> }
  | { action: "delete"; archiveId: string }
  | { action: "generate-posts"; archiveId: string; count?: number; customInstruction?: string; selectedMemoryEntryIds?: string[]; selectedMemorySummaries?: string[]; textModelBranch?: "free" }
  | { action: "enqueue-posts"; archiveId: string; postIds?: string[]; padCode?: string; platform?: string; telegramChatId?: string }
  | { action: "finalize-published"; archiveId: string; postIds: string[]; publishedContentById?: Record<string, string>; publishedMetaById?: Record<string, any> };

export async function runPersonaWorkflow(input: PersonaWorkflowInput) {
  switch (input.action) {
    case "create": {
      const archive = await createPersonaArchive({
        name: input.name,
        content: input.content,
        setup: input.setup,
        ownerBotName: input.ownerBotName,
        boundTelegramChatId: input.boundTelegramChatId,
      });
      return {
        ok: true,
        action: "create",
        archiveId: archive.id,
        name: archive.name,
        postCount: archive.posts.length,
      };
    }

    case "list": {
      const archives = await listPersonaArchives();
      return {
        ok: true,
        action: "list",
        archives: archives.map((a) => ({
          id: a.id,
          name: a.name,
          postCount: a.posts.length,
          publishedCount: a.publishHistory?.length || 0,
          updatedAt: a.updatedAt,
        })),
      };
    }

    case "get": {
      const archive = await loadPersonaArchive(input.archiveId);
      if (!archive) throw new Error("人设不存在");
      return {
        ok: true,
        action: "get",
        archive,
      };
    }

    case "update": {
      const archive = await updatePersonaArchiveProfile(input.archiveId, {
        name: input.name,
        content: input.content,
        setup: input.setup as DramaSetup | undefined,
      });
      if (!archive) throw new Error("人设不存在");
      return {
        ok: true,
        action: "update",
        archiveId: archive.id,
        name: archive.name,
        content: archive.content,
      };
    }

    case "delete": {
      await deletePersonaArchive(input.archiveId);
      return {
        ok: true,
        action: "delete",
        archiveId: input.archiveId,
      };
    }

    case "generate-posts": {
      const archive = await loadPersonaArchive(input.archiveId);
      if (!archive) throw new Error("人设不存在");

      const targetCount = input.count || 3;
      const memoryContext = await buildPersonaGenerationMemoryPrompt(archive);
      const selectedIdSet = new Set((input.selectedMemoryEntryIds || []).map((id) => String(id).trim()).filter(Boolean));
      const selectedEntries = [
        ...memoryContext.persistedEntries.filter((entry) => selectedIdSet.has(entry.id)),
        ...(input.selectedMemorySummaries || [])
          .map((summary, index) => ({
            id: `selected-summary-${index}`,
            date: new Date().toISOString(),
            summary: String(summary || "").trim(),
          }))
          .filter((entry) => entry.summary),
      ];
      const selectedMemoryInstruction = buildSelectedMemoryInstruction(selectedEntries);
      const effectiveSetup = {
        ...(archive.setup || {}),
        targetMarket: (archive.setup as any)?.targetMarket || "cn",
        chineseScript: "traditional",
      };
      const tweetStyleInstruction = buildTweetStyleInstruction(effectiveSetup);
      const linkEndingInstruction = buildLinkEndingInstruction(effectiveSetup);
      const chineseScriptInstruction = buildChineseScriptInstruction(archive);
      const customInstruction = [
        input.customInstruction || "",
        chineseScriptInstruction,
        tweetStyleInstruction,
        linkEndingInstruction,
        selectedMemoryInstruction,
      ].filter((part) => part.trim()).join("\n\n");
      const trendIntel = await fetchPersonaTrendIntelForNode(
        effectiveSetup as DramaSetup,
        archive.id,
        archive.name,
      );
      const prompt = buildSocialPostsPrompt(
        effectiveSetup as DramaSetup,
        archive.content,
        targetCount,
        customInstruction,
        memoryContext.existingCount,
        memoryContext.memoryText,
        memoryContext.recentPosts,
        trendIntel,
        undefined,
        [input.customInstruction || "", chineseScriptInstruction].filter((part) => part.trim()).join("\n\n"),
      );

      const generated = await generateTextWithGemini(prompt, targetCount);
      let posts = ensurePostsContainLinkEndingPreset(parsePosts(generated, targetCount), archive.setup);

      let attempts = 0;
      while (posts.length < targetCount && attempts < 3) {
        const missing = targetCount - posts.length;
        const retryPrompt = [
          customInstruction,
          `现在只补充剩余 ${missing} 篇推文。`,
          `前面已经成功生成 ${posts.length} 篇，不要重复前面的内容。`,
          "必须直接输出缺少的推文正文，每篇之间只能用 --- 分隔。",
          trendIntel ? `必须继续自然结合以下今日人设时事情报，不要写成新闻摘要：\n${trendIntel.slice(0, 1200)}` : "",
          "不要输出思考过程，不要输出说明，不要输出检查文本，不要输出标题说明。",
        ].join("\n");
        const retryGenerated = await generateTextWithGemini(retryPrompt, missing);
        const retryPosts = ensurePostsContainLinkEndingPreset(parsePosts(retryGenerated, missing), archive.setup).map((post, index) => ({
          ...post,
          number: posts.length + index + 1,
          title: `第${posts.length + index + 1}篇`,
          orderIndex: posts.length + index,
        }));
        posts = [...posts, ...retryPosts].slice(0, targetCount);
        attempts += 1;
      }

      posts = await attachMemorySummariesToPosts(posts, archive, memoryContext.existingCount);
      const saved = await appendEpisodesToArchive(archive.id, posts);

      return {
        ok: true,
        action: "generate-posts",
        archiveId: archive.id,
        generatedCount: saved.length,
        selectedMemoryCount: selectedEntries.length,
        postIds: saved.map((p) => p.archivePostId),
        posts: saved.map((p) => ({ id: p.archivePostId, content: p.content, memorySummary: p.memorySummary })),
      };
    }

    case "enqueue-posts": {
      const archive = await loadPersonaArchive(input.archiveId);
      if (!archive) throw new Error("人设不存在");
      const repo = createNodePublishQueueRepository();
      const postIdSet = new Set(input.postIds || []);
      const platform = input.platform || "threads";
      const platformPosts = getArchivePendingPostsForPlatform(archive, platform);
      const selectedPosts = (input.postIds?.length
        ? platformPosts.filter((post) => postIdSet.has(post.id))
        : platformPosts.slice(0, 1)
      );
      if (!selectedPosts.length) {
        return {
          ok: true,
          action: "enqueue-posts",
          archiveId: archive.id,
          enqueued: [],
          skipped: [],
        };
      }
      const existingActive = repo.listTasks({ archive_id: archive.id }).filter((task) =>
        ["pending", "publishing", "paused"].includes(task.status),
      );
      const existingKeys = new Set(existingActive.map((task) => `${task.archive_post_id}::${task.platform}::${task.pad_code}`));
      const enqueued: Array<{ taskId: string; postId: string }> = [];
      const skipped: Array<{ postId: string; reason: string }> = [];
      const padCode = input.padCode || archive.boundPadCode || "ACP250801768QX47";

      for (const post of selectedPosts) {
        const dedupeKey = `${post.id}::${platform}::${padCode}`;
        if (existingKeys.has(dedupeKey)) {
          skipped.push({ postId: post.id, reason: "already-enqueued" });
          continue;
        }
        const telegramTargetGroupName = platform === "telegram"
          ? archive.boundTelegramFreeGroupName
          : undefined;
        const telegramTargetChatId = platform === "telegram"
          ? archive.boundTelegramFreeGroupId
          : undefined;
        const activeLinkEndingPreset = resolveActiveLinkEndingPreset(archive.setup);
        const finalCaption = activeLinkEndingPreset
          ? applyLinkEndingPresetToContent(post.content, activeLinkEndingPreset)
          : post.content;
        const task = repo.enqueueTask({
          archive_id: archive.id,
          archive_post_id: post.id,
          pad_code: padCode,
          platform,
          caption: finalCaption,
          media_url: post.imageUrl,
          telegram_chat_id: input.telegramChatId,
          telegram_target_chat_id: telegramTargetChatId,
          telegram_target_group_name: telegramTargetGroupName,
          telegram_group_content_type: platform === "telegram" ? "free" : undefined,
        });
        existingKeys.add(dedupeKey);
        enqueued.push({ taskId: task.id, postId: post.id });
      }

      return {
        ok: true,
        action: "enqueue-posts",
        archiveId: archive.id,
        enqueued,
        skipped,
      };
    }

    case "finalize-published": {
      const archive = await markArchiveEpisodesPublished(
        input.archiveId,
        input.postIds,
        input.publishedContentById || {},
        input.publishedMetaById || {},
      );
      if (!archive) throw new Error("人设不存在或没有可归档推文");
      return {
        ok: true,
        action: "finalize-published",
        archiveId: archive.id,
        remainingPostCount: archive.posts.length,
        publishedCount: archive.publishHistory?.length || 0,
      };
    }
  }
}
