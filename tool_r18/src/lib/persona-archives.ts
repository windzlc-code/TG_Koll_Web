import type { DramaProject } from "@/types/drama";
import fs from "node:fs";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { addPostToMemory, buildMemoryOutline, deleteMemory } from "./persona-memory-v2";
import { WORKFLOW_PERSONA_SEEDS } from "./workflow-personas";
import {
  appendEpisodesToArchivePosts,
  archivePostsToEpisodes,
  buildArchivePostFromEpisode,
  reorderArchivePostsByIds,
  replaceArchivePostsFromEpisodes,
  type ArchiveSetup,
  type PersonaArchive,
  type PersonaArchivePost,
  type PersonaImageLibraryItem,
  type PersonaPublishMeta,
  type PersonaPublishRecord,
} from "@/core/archives/persona-archive-domain";
import { sanitizeGeneratedPostContent } from "@/core/persona/generated-post-parser";

const ARCHIVES_KEY = "persona_archives_v2";
const LEGACY_PRESETS_KEY = "persona_presets";
const LEGACY_PROJECTS_KEY = "storyforge_drama_projects";
const WORKFLOW_PERSONAS_SEEDED_KEY = "workflow_persona_archives_seeded_v1";
const buildArchiveMemoryOutline = buildMemoryOutline;
const WORKFLOW_PERSONA_ID_PREFIX = "workflow-persona-";
const PUBLISH_PLATFORMS = ["threads", "telegram"] as const;
type PublishPlatformQueue = typeof PUBLISH_PLATFORMS[number];

type EpisodeScript = import("@/types/drama").EpisodeScript;

interface LegacyPersonaPreset {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  setup?: ArchiveSetup;
}


interface PersonaArchivesBridge {
  save: (archive: unknown) => Promise<{ ok?: boolean; error?: string } | undefined>;
  load: (id: string) => Promise<unknown | null>;
  list: () => Promise<unknown[]>;
  delete: (id: string) => Promise<{ ok?: boolean; error?: string } | undefined>;
}

const memoryStorage = new Map<string, string>();
const nodeStorageFile = resolveRuntimeFile("persona_archives_cache.json");
let nodeStorageCache: { mtimeMs: number; data: Record<string, string> } | null = null;

function getNodeStorageMtimeMs(): number {
  try {
    return fs.statSync(nodeStorageFile).mtimeMs;
  } catch {
    return 0;
  }
}

function readNodeStorage(): Record<string, string> {
  try {
    if (!fs.existsSync(nodeStorageFile)) return {};
    const mtimeMs = getNodeStorageMtimeMs();
    if (nodeStorageCache && nodeStorageCache.mtimeMs === mtimeMs) {
      return nodeStorageCache.data;
    }
    const startedAt = Date.now();
    const parsed = JSON.parse(fs.readFileSync(nodeStorageFile, "utf-8"));
    if (Array.isArray(parsed)) {
      const data = { [ARCHIVES_KEY]: JSON.stringify(parsed) };
      nodeStorageCache = { mtimeMs, data };
      return data;
    }
    const data = parsed || {};
    nodeStorageCache = { mtimeMs, data };
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 500) {
      console.warn(`[persona-archives][node_storage_read_slow] bytes=${fs.statSync(nodeStorageFile).size} ms=${elapsed}`);
    }
    return data;
  } catch {
    return {};
  }
}

function writeNodeStorage(next: Record<string, string>) {
  try {
    const startedAt = Date.now();
    fs.writeFileSync(nodeStorageFile, JSON.stringify(next, null, 2), "utf-8");
    nodeStorageCache = { mtimeMs: getNodeStorageMtimeMs(), data: next };
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 500) {
      console.warn(`[persona-archives][node_storage_write_slow] bytes=${fs.statSync(nodeStorageFile).size} ms=${elapsed}`);
    }
  } catch {
    // ignore file cache errors
  }
}

const storageShim = {
  getItem(key: string): string | null {
    if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
      return window.localStorage.getItem(key);
    }
    const fileData = readNodeStorage();
    if (key in fileData) return fileData[key] ?? null;
    return memoryStorage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
      window.localStorage.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    const fileData = readNodeStorage();
    fileData[key] = value;
    writeNodeStorage(fileData);
  },
  removeItem(key: string) {
    if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
      window.localStorage.removeItem(key);
      return;
    }
    memoryStorage.delete(key);
    const fileData = readNodeStorage();
    delete fileData[key];
    writeNodeStorage(fileData);
  },
};

const archiveAPI = (): PersonaArchivesBridge | undefined =>
  (typeof window !== "undefined" ? (window as any).electronAPI?.personaArchives : undefined);
const hasElectronMemoryAPI = (): boolean =>
  Boolean(typeof window !== "undefined" ? (window as any).electronAPI?.memory : undefined);

function safeArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function findMatchingJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractArchiveObjectJsonById(arrayJson: string, id: string): string | null {
  const idLiteral = jsonStringLiteral(id);
  const exactNeedle = `"id":${idLiteral}`;
  let matchIndex = arrayJson.indexOf(exactNeedle);
  if (matchIndex < 0) {
    const spacedPattern = new RegExp(`"id"\\s*:\\s*${idLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const match = spacedPattern.exec(arrayJson);
    matchIndex = match?.index ?? -1;
  }
  if (matchIndex < 0) return null;

  const start = arrayJson.lastIndexOf("{", matchIndex);
  if (start < 0) return null;
  const end = findMatchingJsonObjectEnd(arrayJson, start);
  if (end < 0) return null;
  return arrayJson.slice(start, end + 1);
}

function toIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizePost(raw: any, fallbackIndex: number): PersonaArchivePost {
  const now = new Date().toISOString();
  const createdAt = toIso(raw?.createdAt, now);
  const updatedAt = toIso(raw?.updatedAt, createdAt);
  const publishedAt = typeof raw?.publishedAt === "string" ? raw.publishedAt : undefined;
  const rawContent = typeof raw?.content === "string" ? sanitizeGeneratedPostContent(raw.content) : "";
  const legacyPublishedOriginal = typeof raw?.publishedOriginal === "string" ? raw.publishedOriginal : "";
  const rawPublishedMemory = typeof raw?.publishedMemory === "string" ? raw.publishedMemory : "";
  const rawMemorySummary = typeof raw?.memorySummary === "string" ? raw.memorySummary : "";
  const publishedMemory = publishedAt
    ? buildArchiveMemoryOutline(rawPublishedMemory || legacyPublishedOriginal || rawContent)
    : undefined;
  const content = publishedAt ? (publishedMemory || "") : rawContent;
  const title = typeof raw?.title === "string" && raw.title.trim()
    ? raw.title
    : `貼文 #${fallbackIndex + 1}`;
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    title,
    content,
    wordCount: !publishedAt && typeof raw?.wordCount === "number" && raw.wordCount > 0 ? raw.wordCount : content.length,
    orderIndex: typeof raw?.orderIndex === "number" && Number.isFinite(raw.orderIndex)
      ? raw.orderIndex
      : fallbackIndex,
    createdAt,
    updatedAt,
    publishedAt,
    publishedMemory,
    memorySummary: rawMemorySummary || publishedMemory,
    imageUrl: typeof raw?.imageUrl === "string" ? raw.imageUrl : undefined,
    mediaUrl: typeof raw?.mediaUrl === "string" ? raw.mediaUrl : typeof raw?.media_url === "string" ? raw.media_url : undefined,
    mediaType: raw?.mediaType === "video" || raw?.media_type === "video"
      ? "video"
      : raw?.mediaType === "image" || raw?.media_type === "image"
        ? "image"
        : raw?.mediaType === "unknown" || raw?.media_type === "unknown"
          ? "unknown"
          : undefined,
    mediaItems: Array.isArray(raw?.mediaItems) ? raw.mediaItems : Array.isArray(raw?.media_items) ? raw.media_items : undefined,
    sourceMeta: raw?.sourceMeta && typeof raw.sourceMeta === "object"
      ? raw.sourceMeta
      : raw?.source_meta && typeof raw.source_meta === "object"
        ? raw.source_meta
        : undefined,
    imageHistory: Array.isArray(raw?.imageHistory) ? raw.imageHistory : undefined,
    history: Array.isArray(raw?.history) ? raw.history : undefined,
    telegramGroupContentType: raw?.telegramGroupContentType === "paid" ? "paid" : raw?.telegramGroupContentType === "free" ? "free" : undefined,
  };
}

function normalizePersonaImageLibraryItem(raw: any, fallbackIndex: number): PersonaImageLibraryItem | null {
  if (typeof raw?.imageUrl !== "string" || !raw.imageUrl) return null;
  const now = new Date().toISOString();
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    imageUrl: raw.imageUrl,
    createdAt: toIso(raw?.createdAt, now),
    prompt: typeof raw?.prompt === "string" ? raw.prompt : undefined,
    mode: raw?.mode === "workflow" || raw?.mode === "closed-model" ? raw.mode : undefined,
    source: raw?.source === "portrait" || raw?.source === "lifestyle" || raw?.source === "scene" || raw?.source === "pov" || raw?.source === "manual-upload"
      ? raw.source
      : undefined,
    aspectRatio: typeof raw?.aspectRatio === "string" ? raw.aspectRatio : undefined,
    notes: typeof raw?.notes === "string" ? raw.notes : undefined,
  };
}

function normalizePublishRecord(raw: any, fallbackIndex: number): PersonaPublishRecord {
  const now = new Date().toISOString();
  const publishedAt = toIso(raw?.publishedAt, raw?.createdAt || now);
  const content = typeof raw?.content === "string" ? raw.content : "";
  const rawPublishedMeta = raw?.publishedMeta && typeof raw.publishedMeta === "object"
    ? raw.publishedMeta
    : undefined;
  const legacySourceHotspotMeta = rawPublishedMeta?.source === "published_source_hotspot"
    ? rawPublishedMeta
    : undefined;
  const title = typeof raw?.title === "string" && raw.title.trim()
    ? raw.title
    : `發布紀錄 #${fallbackIndex + 1}`;
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    archivePostId: typeof raw?.archivePostId === "string" ? raw.archivePostId : undefined,
    title,
    content,
    wordCount: typeof raw?.wordCount === "number" && raw.wordCount > 0 ? raw.wordCount : content.length,
    publishedAt,
    platform: typeof raw?.platform === "string" ? raw.platform : undefined,
    padCode: typeof raw?.padCode === "string" ? raw.padCode : undefined,
    padName: typeof raw?.padName === "string" ? raw.padName : undefined,
    imageUrl: typeof raw?.imageUrl === "string"
      ? raw.imageUrl
      : typeof raw?.mediaUrl === "string"
        ? raw.mediaUrl
        : undefined,
    screenshotUrl: typeof raw?.screenshotUrl === "string" ? raw.screenshotUrl : undefined,
    telegramGroupContentType: raw?.telegramGroupContentType === "paid" ? "paid" : raw?.telegramGroupContentType === "free" ? "free" : undefined,
    sourceMeta: raw?.sourceMeta && typeof raw.sourceMeta === "object"
      ? raw.sourceMeta
      : legacySourceHotspotMeta,
    publishedUrl: typeof raw?.publishedUrl === "string" ? raw.publishedUrl : undefined,
    publishedMeta: rawPublishedMeta && rawPublishedMeta.source !== "published_source_hotspot"
      ? rawPublishedMeta
      : undefined,
    publishedTargets: Array.isArray(raw?.publishedTargets)
      ? raw.publishedTargets
        .filter((target: any) => target && typeof target === "object")
        .map((target: any) => ({
          platform: typeof target.platform === "string" ? target.platform : undefined,
          padCode: typeof target.padCode === "string" ? target.padCode : undefined,
          padName: typeof target.padName === "string" ? target.padName : undefined,
          publishedUrl: typeof target.publishedUrl === "string" ? target.publishedUrl : undefined,
          publishedMeta: target.publishedMeta && typeof target.publishedMeta === "object" ? target.publishedMeta : undefined,
          screenshotUrl: typeof target.screenshotUrl === "string" ? target.screenshotUrl : undefined,
        }))
      : undefined,
  };
}

function normalizeWorkflowSeedSetup(
  rawId: unknown,
  rawSetup: any,
  workflowSeed: WorkflowPersonaSeed | undefined,
): ArchiveSetup | undefined {
  const merged = rawSetup && typeof rawSetup === "object"
    ? { ...(workflowSeed?.setup || {}), ...rawSetup }
    : workflowSeed?.setup
      ? { ...workflowSeed.setup }
      : undefined;

  if (!merged) return undefined;

  const isWorkflowPersona = typeof rawId === "string" && rawId.startsWith("workflow-persona-");
  if (isWorkflowPersona && merged.totalEpisodes === 3) {
    merged.totalEpisodes = 50;
  }
  if (workflowSeed?.setup?.imageWorkflow) {
    merged.imageWorkflow = workflowSeed.setup.imageWorkflow;
  }

  return merged;
}

function normalizePlatformPosts(raw: any, fallbackPosts: PersonaArchivePost[]): Record<string, PersonaArchivePost[]> {
  const output: Record<string, PersonaArchivePost[]> = {};
  for (const platform of PUBLISH_PLATFORMS) {
    const rawPosts = raw && typeof raw === "object" && Array.isArray(raw[platform])
      ? raw[platform]
      : null;
    output[platform] = rawPosts
      ? sortArchivePosts(rawPosts.map((post: any, index: number) => normalizePost(post, index)))
      : sortArchivePosts(fallbackPosts);
  }
  return output;
}

function platformFromMeta(metaById: Record<string, PersonaPublishMeta>): PublishPlatformQueue | undefined {
  for (const meta of Object.values(metaById)) {
    const platform = String(meta?.platform || "").trim();
    if (PUBLISH_PLATFORMS.includes(platform as PublishPlatformQueue)) return platform as PublishPlatformQueue;
  }
  return undefined;
}

export function getArchivePendingPostsForPlatform(
  archive: Pick<PersonaArchive, "posts" | "platformPosts"> | null | undefined,
  platform?: string,
): PersonaArchivePost[] {
  const normalizedPlatform = PUBLISH_PLATFORMS.includes(platform as PublishPlatformQueue)
    ? platform as PublishPlatformQueue
    : undefined;
  if (!normalizedPlatform) return sortArchivePosts(archive?.posts || []);
  const posts = archive?.platformPosts?.[normalizedPlatform];
  return sortArchivePosts(Array.isArray(posts) ? posts : archive?.posts || []);
}

function withPlatformQueues(
  archive: PersonaArchive,
  updater: (posts: PersonaArchivePost[], platform: PublishPlatformQueue) => PersonaArchivePost[],
): PersonaArchive {
  const current = normalizePlatformPosts(archive.platformPosts, archive.posts || []);
  const platformPosts: Record<string, PersonaArchivePost[]> = {};
  for (const platform of PUBLISH_PLATFORMS) {
    platformPosts[platform] = sortArchivePosts(updater(current[platform] || [], platform));
  }
  return {
    ...archive,
    posts: platformPosts.threads || [],
    platformPosts,
  };
}

function normalizeArchive(raw: any): PersonaArchive {
  const now = new Date().toISOString();
  const createdAt = toIso(raw?.createdAt, now);
  const posts = Array.isArray(raw?.posts)
    ? raw.posts.map((post: any, index: number) => normalizePost(post, index))
    : [];
  const favoritePosts = Array.isArray(raw?.favoritePosts)
    ? raw.favoritePosts.map((post: any, index: number) => normalizePost(post, index))
    : [];
  const platformPosts = normalizePlatformPosts(raw?.platformPosts, posts);
  const publishHistory = Array.isArray(raw?.publishHistory)
    ? raw.publishHistory.map((record: any, index: number) => normalizePublishRecord(record, index))
    : [];
  const personaImageLibrary = Array.isArray(raw?.personaImageLibrary)
    ? raw.personaImageLibrary
        .map((item: any, index: number) => normalizePersonaImageLibraryItem(item, index))
        .filter(Boolean) as PersonaImageLibraryItem[]
    : [];
  const workflowSeed = WORKFLOW_PERSONA_SEEDS.find((seed) => seed.id === raw?.id);
  const normalizedSetup = normalizeWorkflowSeedSetup(raw?.id, raw?.setup, workflowSeed);
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name : "未命名人設",
    content: typeof raw?.content === "string" ? raw.content : "",
    createdAt,
    updatedAt: toIso(raw?.updatedAt, posts.at(-1)?.updatedAt || createdAt),
    setup: normalizedSetup,
    boundPadCode: typeof raw?.boundPadCode === "string" && raw.boundPadCode.trim()
      ? raw.boundPadCode.trim()
      : undefined,
    boundPadName: typeof raw?.boundPadName === "string" && raw.boundPadName.trim()
      ? raw.boundPadName.trim()
      : undefined,
    boundTelegramChatId: typeof raw?.boundTelegramChatId === "string" && raw.boundTelegramChatId.trim()
      ? raw.boundTelegramChatId.trim()
      : undefined,
    boundTelegramFreeGroupId: typeof raw?.boundTelegramFreeGroupId === "string" && raw.boundTelegramFreeGroupId.trim()
      ? raw.boundTelegramFreeGroupId.trim()
      : undefined,
    boundTelegramPaidGroupId: typeof raw?.boundTelegramPaidGroupId === "string" && raw.boundTelegramPaidGroupId.trim()
      ? raw.boundTelegramPaidGroupId.trim()
      : undefined,
    boundTelegramFreeGroupName: typeof raw?.boundTelegramFreeGroupName === "string" && raw.boundTelegramFreeGroupName.trim()
      ? raw.boundTelegramFreeGroupName.trim()
      : undefined,
    boundTelegramPaidGroupName: typeof raw?.boundTelegramPaidGroupName === "string" && raw.boundTelegramPaidGroupName.trim()
      ? raw.boundTelegramPaidGroupName.trim()
      : undefined,
    ownerBotName: typeof raw?.ownerBotName === "string" && raw.ownerBotName.trim()
      ? raw.ownerBotName.trim()
      : undefined,
    posts: sortArchivePosts(platformPosts.threads || posts),
    favoritePosts: sortArchivePosts(favoritePosts),
    platformPosts,
    publishHistory: sortPublishHistory(publishHistory),
    personaImageLibrary,
    personaReferenceSheet: typeof raw?.personaReferenceSheet === "string" && raw.personaReferenceSheet
      ? raw.personaReferenceSheet
      : undefined,
  };
}

function normalizeArchives(items: any[]): PersonaArchive[] {
  return items
    .map(normalizeArchive)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function archivesChanged(rawItems: any[], normalized: PersonaArchive[]): boolean {
  try {
    return JSON.stringify(rawItems) !== JSON.stringify(normalized);
  } catch {
    return true;
  }
}

function sortArchivePosts(posts: PersonaArchivePost[]): PersonaArchivePost[] {
  return [...posts].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER);
    if (orderDiff !== 0) return orderDiff;
    const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (createdDiff !== 0) return createdDiff;
    return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  });
}

function sortPublishHistory(records: PersonaPublishRecord[]): PersonaPublishRecord[] {
  return [...records].sort((a, b) => {
    const publishedDiff = new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    if (publishedDiff !== 0) return publishedDiff;
    return a.title.localeCompare(b.title, "zh-TW");
  });
}

function migrateLegacyPresets(): PersonaArchive[] {
  const presets = safeArray<LegacyPersonaPreset>(storageShim.getItem(LEGACY_PRESETS_KEY));
  if (presets.length === 0) return [];
  return normalizeArchives(
    presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      content: preset.content,
      createdAt: preset.createdAt,
      updatedAt: preset.createdAt,
      setup: preset.setup,
      posts: [],
    })),
  );
}

function migrateLegacyProjects(): PersonaArchive[] {
  const projects = safeArray<DramaProject>(storageShim.getItem(LEGACY_PROJECTS_KEY));
  if (projects.length === 0) return [];

  return normalizeArchives(
    projects
      .filter((project) => project && project.characters && Array.isArray(project.episodes) && project.episodes.length > 0)
      .map((project) => {
        const baseCreatedAt = typeof project.createdAt === "string" ? project.createdAt : new Date().toISOString();
        return {
          id: project.id,
          name: project.dramaTitle || project.setup?.personaName || project.setup?.genres?.join(" + ") || "未命名人設",
          content: project.characters || "",
          createdAt: project.createdAt || new Date().toISOString(),
          updatedAt: project.updatedAt || project.createdAt || new Date().toISOString(),
          setup: project.setup ? { ...project.setup } : undefined,
          posts: (project.episodes || []).map((ep, index) => {
            const createdAt = ep.createdAt || new Date(new Date(baseCreatedAt).getTime() + index).toISOString();
            return {
              id: ep.archivePostId || `${project.id}-legacy-${index + 1}`,
              title: ep.title || `貼文 #${index + 1}`,
              content: ep.content || "",
              wordCount: ep.wordCount || (ep.content || "").length,
              orderIndex: index,
              createdAt,
              updatedAt: ep.updatedAt || project.updatedAt || createdAt,
              publishedAt: ep.publishedAt,
              publishedMemory: ep.publishedAt ? buildArchiveMemoryOutline(ep.content || "") : undefined,
              memorySummary: ep.memorySummary,
              imageUrl: ep.imageUrl,
              imageHistory: ep.imageHistory,
              history: ep.history,
            };
          }),
        };
      }),
  );
}

function buildWorkflowPersonaArchive(seed: WorkflowPersonaSeed, existing: PersonaArchive | undefined, now: string): PersonaArchive {
  const setup = {
    ...(existing?.setup || {}),
    ...seed.setup,
    imageWorkflow: seed.setup.imageWorkflow,
    personaName: seed.setup.personaName || seed.name,
  };
  return normalizeArchive({
    ...(existing || {}),
    id: seed.id,
    name: seed.name,
    content: seed.content,
    createdAt: existing?.createdAt || now,
    updatedAt: existing?.updatedAt || now,
    setup,
    posts: existing?.posts || [],
    publishHistory: existing?.publishHistory || [],
    personaImageLibrary: existing?.personaImageLibrary || [],
    personaReferenceSheet: existing?.personaReferenceSheet,
  });
}

function isEmptyWorkflowSeedArchive(archive: PersonaArchive): boolean {
  if (!archive.id.startsWith(WORKFLOW_PERSONA_ID_PREFIX)) return false;
  const seed = WORKFLOW_PERSONA_SEEDS.find((item) => item.id === archive.id);
  if (!seed) return false;
  return archive.posts.length === 0
    && (archive.publishHistory || []).length === 0
    && (archive.personaImageLibrary || []).length === 0
    && archive.name === seed.name
    && archive.content === seed.content;
}

function syncWorkflowPersonaArchives(archives: PersonaArchive[]): PersonaArchive[] {
  const shouldSync = storageShim.getItem(WORKFLOW_PERSONAS_SEEDED_KEY) !== "1"
    || archives.some((archive) => archive.id.startsWith(WORKFLOW_PERSONA_ID_PREFIX));
  if (!shouldSync) return normalizeArchives(archives);

  const now = new Date().toISOString();
  const seedIds = new Set(WORKFLOW_PERSONA_SEEDS.map((seed) => seed.id));
  const withoutStaleWorkflowPersonas = archives.filter((archive) =>
    !archive.id.startsWith(WORKFLOW_PERSONA_ID_PREFIX) || seedIds.has(archive.id),
  );
  const byId = new Map(withoutStaleWorkflowPersonas.map((archive) => [archive.id, archive]));
  for (const seed of WORKFLOW_PERSONA_SEEDS) {
    byId.set(seed.id, buildWorkflowPersonaArchive(seed, byId.get(seed.id), now));
  }
  return normalizeArchives([...byId.values()]);
}

function createWorkflowPersonaArchives(cached: PersonaArchive[]): PersonaArchive[] {
  if (storageShim.getItem(WORKFLOW_PERSONAS_SEEDED_KEY) === "1") return [];
  const cachedIds = new Set(cached.map((archive) => archive.id));
  const now = new Date().toISOString();
  return normalizeArchives(
    WORKFLOW_PERSONA_SEEDS
      .filter((seed) => !cachedIds.has(seed.id))
      .map((seed) => ({
        id: seed.id,
        name: seed.name,
        content: seed.content,
        createdAt: now,
        updatedAt: now,
        setup: seed.setup,
        posts: [],
      })),
  );
}

function getLocalArchives(): PersonaArchive[] {
  const cached = safeArray<PersonaArchive>(storageShim.getItem(ARCHIVES_KEY));
  const normalizedCached = normalizeArchives(cached);
  const workflowSeeds = createWorkflowPersonaArchives(normalizedCached);
  const merged = syncWorkflowPersonaArchives(mergeArchives(
    normalizedCached,
    [
      ...migrateLegacyPresets(),
      ...migrateLegacyProjects(),
      ...workflowSeeds,
    ],
  ));
  if (archivesChanged(cached, merged)) {
    saveLocalArchives(merged, Boolean(archiveAPI()));
  }
  if (workflowSeeds.length > 0) {
    storageShim.setItem(WORKFLOW_PERSONAS_SEEDED_KEY, "1");
  }
  return merged;
}

function getLocalArchiveById(id: string): PersonaArchive | null {
  const raw = storageShim.getItem(ARCHIVES_KEY);
  if (raw) {
    const objectJson = extractArchiveObjectJsonById(raw, id);
    if (objectJson) {
      try {
        return normalizeArchive(JSON.parse(objectJson));
      } catch {
        return null;
      }
    }
  }
  const seed = WORKFLOW_PERSONA_SEEDS.find((item) => item.id === id);
  return seed ? buildWorkflowPersonaArchive(seed, undefined, new Date().toISOString()) : null;
}

function stripLargeMediaForLocalCache(archive: PersonaArchive): PersonaArchive {
  return {
    ...archive,
    posts: archive.posts.map((post) => ({
      ...post,
      imageUrl: post.imageUrl?.startsWith("data:") ? undefined : post.imageUrl,
      imageHistory: post.imageHistory?.filter((entry) => !entry.imageUrl?.startsWith("data:")),
    })),
    publishHistory: archive.publishHistory?.map((record) => ({
      ...record,
      imageUrl: record.imageUrl?.startsWith("data:") ? undefined : record.imageUrl,
      screenshotUrl: record.screenshotUrl?.startsWith("data:") ? undefined : record.screenshotUrl,
    })),
    // Keep personaReferenceSheet — it's the primary identity reference, worth the storage cost
    // Keep personaImageLibrary image URLs as-is
  };
}

function saveLocalArchives(archives: PersonaArchive[], allowLightweightFallback = false): void {
  const normalized = normalizeArchives(archives);
  const cacheValue = allowLightweightFallback
    ? normalized.map(stripLargeMediaForLocalCache)
    : normalized;
  try {
    storageShim.setItem(ARCHIVES_KEY, JSON.stringify(cacheValue));
  } catch (error) {
    if (!allowLightweightFallback) throw error;
    storageShim.setItem(ARCHIVES_KEY, JSON.stringify(normalized.map(stripLargeMediaForLocalCache)));
  }
}

async function saveElectronArchive(archive: PersonaArchive): Promise<void> {
  const api = archiveAPI();
  if (!api) return;
  const result = await api.save(archive);
  if (result?.ok === false) {
    throw new Error(result.error || "Electron 存檔寫入失敗");
  }
}

function mergeArchives(localArchives: PersonaArchive[], remoteArchives: PersonaArchive[]): PersonaArchive[] {
  const byId = new Map<string, PersonaArchive>();
  for (const archive of [...localArchives, ...remoteArchives]) {
    const normalized = normalizeArchive(archive);
    const existing = byId.get(normalized.id);
    const normalizedIsEmptySeed = isEmptyWorkflowSeedArchive(normalized);
    const existingIsEmptySeed = existing ? isEmptyWorkflowSeedArchive(existing) : false;
    const normalizedHasData = normalized.posts.length > 0
      || (normalized.publishHistory || []).length > 0
      || (normalized.personaImageLibrary || []).length > 0;
    const existingHasData = existing ? (
      existing.posts.length > 0
      || (existing.publishHistory || []).length > 0
      || (existing.personaImageLibrary || []).length > 0
    ) : false;
    if (
      !existing
      || (existingIsEmptySeed && normalizedHasData)
      || (!normalizedIsEmptySeed && !existingHasData && new Date(normalized.updatedAt).getTime() >= new Date(existing.updatedAt).getTime())
      || (!normalizedIsEmptySeed && existingHasData && new Date(normalized.updatedAt).getTime() >= new Date(existing.updatedAt).getTime())
    ) {
      byId.set(normalized.id, normalized);
    }
  }
  return normalizeArchives([...byId.values()]);
}

async function persistArchive(archive: PersonaArchive): Promise<PersonaArchive> {
  const normalized = normalizeArchive(archive);
  const local = getLocalArchives();
  const next = local.some((item) => item.id === normalized.id)
    ? local.map((item) => (item.id === normalized.id ? normalized : item))
    : [normalized, ...local];
  const api = archiveAPI();
  if (api) {
    await saveElectronArchive(normalized);
  }
  try {
    saveLocalArchives(next, Boolean(api));
  } catch (error) {
    if (!api) throw error;
  }
  return normalized;
}

export function getCachedPersonaArchives(): PersonaArchive[] {
  return getLocalArchives();
}

export function getCachedPersonaArchive(id: string): PersonaArchive | null {
  return getLocalArchiveById(id);
}

export async function listPersonaArchives(): Promise<PersonaArchive[]> {
  const local = getLocalArchives();
  const api = archiveAPI();
  if (!api) return local;

  const remoteRaw = await api.list().catch(() => []);
  const remote = normalizeArchives(remoteRaw);
  const merged = syncWorkflowPersonaArchives(mergeArchives(local, remote));
  try {
    saveLocalArchives(merged, true);
  } catch {
    // Electron file storage remains the source of truth when browser cache quota is exhausted.
  }

  const remoteIds = new Set(remote.map((archive) => archive.id));
  const shouldRewriteRemote = archivesChanged(remoteRaw, remote);
  await Promise.all(
    merged
      .filter((archive) => shouldRewriteRemote || !remoteIds.has(archive.id))
      .map((archive) => saveElectronArchive(archive).catch(() => {})),
  );

  return merged;
}

export async function loadPersonaArchive(id: string): Promise<PersonaArchive | null> {
  const api = archiveAPI();
  const cached = getLocalArchiveById(id);
  if (!api) return cached;
  const loaded = await api.load(id).catch(() => null);
  if (!loaded) return cached;
  return normalizeArchive(loaded);
}

export async function savePersonaArchive(archive: PersonaArchive): Promise<PersonaArchive> {
  return persistArchive({
    ...archive,
    updatedAt: new Date().toISOString(),
    posts: sortArchivePosts(archive.posts || []),
    favoritePosts: sortArchivePosts(archive.favoritePosts || []),
    publishHistory: archive.publishHistory,
  });
}

export async function createPersonaArchive(input: {
  id?: string;
  name: string;
  content: string;
  setup?: ArchiveSetup;
  ownerBotName?: string;
  boundTelegramChatId?: string;
}): Promise<PersonaArchive> {
  const now = new Date().toISOString();
  return savePersonaArchive({
    id: input.id || crypto.randomUUID(),
    name: input.name.trim() || "未命名人設",
    content: input.content,
    createdAt: now,
    updatedAt: now,
    setup: input.setup,
    ownerBotName: input.ownerBotName,
    boundTelegramChatId: input.boundTelegramChatId,
    posts: [],
  });
}

export async function savePersonaArchiveImageLibrary(
  id: string,
  items: PersonaImageLibraryItem[],
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(id);
  if (!archive) return null;
  return savePersonaArchive({
    ...archive,
    personaImageLibrary: items,
  });
}

export async function appendPersonaArchiveImage(
  id: string,
  item: Omit<PersonaImageLibraryItem, "id" | "createdAt"> & Partial<Pick<PersonaImageLibraryItem, "id" | "createdAt">>,
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(id);
  if (!archive) return null;
  const nextItem = normalizePersonaImageLibraryItem({
    id: item.id || crypto.randomUUID(),
    createdAt: item.createdAt || new Date().toISOString(),
    ...item,
  }, archive.personaImageLibrary?.length || 0);
  if (!nextItem) return null;
  return savePersonaArchive({
    ...archive,
    personaImageLibrary: [nextItem, ...(archive.personaImageLibrary || [])],
  });
}

export async function deletePersonaArchiveImage(id: string, imageId: string): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(id);
  if (!archive) return null;
  return savePersonaArchive({
    ...archive,
    personaImageLibrary: (archive.personaImageLibrary || []).filter((item) => item.id !== imageId),
  });
}

export async function updatePersonaArchiveProfile(
  id: string,
  patch: Partial<Pick<PersonaArchive, "name" | "content" | "setup">>,
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(id);
  if (!archive) return null;
  const nextName = patch.name?.trim();
  const nextSetup = patch.setup ? { ...(archive.setup || {}), ...patch.setup } : archive.setup;
  return savePersonaArchive({
    ...archive,
    name: nextName || archive.name,
    content: typeof patch.content === "string" ? patch.content : archive.content,
    setup: nextName && nextSetup?.personaName
      ? { ...nextSetup, personaName: nextName }
      : nextSetup,
  });
}

export async function updatePersonaArchivePadBinding(
  id: string,
  binding: {
    padCode?: string;
    padName?: string;
    telegramFreeGroupId?: string;
    telegramPaidGroupId?: string;
    telegramFreeGroupName?: string;
    telegramPaidGroupName?: string;
  },
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(id);
  if (!archive) return null;
  const hasAnyBindingPatch = Object.keys(binding).length > 0;
  return savePersonaArchive({
    ...archive,
    boundPadCode: Object.prototype.hasOwnProperty.call(binding, "padCode")
      ? binding.padCode?.trim() || undefined
      : hasAnyBindingPatch ? archive.boundPadCode : undefined,
    boundPadName: Object.prototype.hasOwnProperty.call(binding, "padName")
      ? binding.padName?.trim() || undefined
      : hasAnyBindingPatch ? archive.boundPadName : undefined,
    boundTelegramFreeGroupId: Object.prototype.hasOwnProperty.call(binding, "telegramFreeGroupId")
      ? binding.telegramFreeGroupId?.trim() || undefined
      : archive.boundTelegramFreeGroupId,
    boundTelegramPaidGroupId: Object.prototype.hasOwnProperty.call(binding, "telegramPaidGroupId")
      ? binding.telegramPaidGroupId?.trim() || undefined
      : archive.boundTelegramPaidGroupId,
    boundTelegramFreeGroupName: Object.prototype.hasOwnProperty.call(binding, "telegramFreeGroupName")
      ? binding.telegramFreeGroupName?.trim() || undefined
      : archive.boundTelegramFreeGroupName,
    boundTelegramPaidGroupName: Object.prototype.hasOwnProperty.call(binding, "telegramPaidGroupName")
      ? binding.telegramPaidGroupName?.trim() || undefined
      : archive.boundTelegramPaidGroupName,
  });
}

export async function savePersonaReferenceSheet(
  id: string,
  referenceSheetUrl: string,
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(id);
  if (!archive) return null;
  return savePersonaArchive({ ...archive, personaReferenceSheet: referenceSheetUrl });
}

export async function deletePersonaArchive(id: string): Promise<void> {
  const next = getLocalArchives().filter((archive) => archive.id !== id);
  saveLocalArchives(next);
  const nextPresets = safeArray<LegacyPersonaPreset>(storageShim.getItem(LEGACY_PRESETS_KEY))
    .filter((preset) => preset.id !== id);
  storageShim.setItem(LEGACY_PRESETS_KEY, JSON.stringify(nextPresets));
  const nextProjects = safeArray<DramaProject>(storageShim.getItem(LEGACY_PROJECTS_KEY))
    .filter((project) => project.id !== id);
  storageShim.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(nextProjects));
  if (archiveAPI()) {
    await archiveAPI().delete(id).catch(() => {});
  }
  await deleteMemory(id).catch(() => {});
}

function buildArchivePostFromEpisode(ep: EpisodeScript, index: number): PersonaArchivePost {
  const now = new Date().toISOString();
  return normalizePost(
    {
      id: ep.archivePostId,
      title: ep.title || `貼文 #${index + 1}`,
      content: ep.content,
      wordCount: ep.wordCount || ep.content.length,
      orderIndex: ep.orderIndex ?? index,
      createdAt: ep.createdAt || now,
      updatedAt: now,
      publishedAt: ep.publishedAt,
      memorySummary: ep.memorySummary,
      imageUrl: ep.imageUrl,
      imageHistory: ep.imageHistory,
      history: ep.history,
    },
    index,
  );
}

export function archivePostsToEpisodes(posts: PersonaArchivePost[]): EpisodeScript[] {
  return sortArchivePosts(posts).map((post, index) => ({
    number: index + 1,
    title: `貼文 #${index + 1}`,
    content: post.content,
    wordCount: typeof post.wordCount === "number" ? post.wordCount : post.content.length,
    orderIndex: post.orderIndex,
    archivePostId: post.id,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    publishedAt: post.publishedAt,
    memorySummary: post.memorySummary,
    imageUrl: post.imageUrl,
    imageHistory: post.imageHistory,
    history: post.history,
  }));
}

export async function appendEpisodesToArchive(
  archiveId: string,
  episodes: EpisodeScript[],
): Promise<EpisodeScript[]> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive || episodes.length === 0) return episodes;

  const { posts: nextPosts, appended: appendedPosts } = appendEpisodesToArchivePosts(archive.posts, episodes);
  const appendedByOriginalId = new Map(appendedPosts.map((post) => [post.id, post]));
  const saved = await savePersonaArchive(withPlatformQueues(
    {
      ...archive,
      posts: nextPosts,
    },
    (posts, platform) => {
      if (platform === "threads") return nextPosts;
      return [
        ...posts,
        ...appendedPosts.map((post) => ({
          ...post,
          id: appendedByOriginalId.get(post.id)?.id || post.id,
        })),
      ];
    },
  ));

  const appendedById = new Map(appendedPosts.map((post) => [post.id, post]));
  return episodes.map((ep, index) => {
    const created = appendedPosts[index];
    if (!created) return ep;
    const savedPost = saved.posts.find((post) => post.id === created.id) || appendedById.get(created.id) || created;
    return {
      ...ep,
      archivePostId: savedPost.id,
      createdAt: savedPost.createdAt,
      updatedAt: savedPost.updatedAt,
      publishedAt: savedPost.publishedAt,
      title: savedPost.title,
      wordCount: savedPost.wordCount,
      orderIndex: savedPost.orderIndex,
      imageUrl: savedPost.imageUrl,
      imageHistory: savedPost.imageHistory,
      history: savedPost.history,
    };
  });
}

export async function updateArchiveEpisode(
  archiveId: string,
  episode: EpisodeScript,
): Promise<EpisodeScript | null> {
  if (!episode.archivePostId) return null;
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;

  const nextPosts = archive.posts.map((post) =>
    post.id === episode.archivePostId
      ? {
          ...buildArchivePostFromEpisode(
            {
              ...episode,
              createdAt: episode.createdAt || post.createdAt,
              publishedAt: episode.publishedAt || post.publishedAt,
              memorySummary: episode.memorySummary || post.memorySummary,
            },
            archive.posts.findIndex((item) => item.id === post.id),
          ),
          publishedAt: post.publishedAt || episode.publishedAt,
          publishedMemory: post.publishedMemory,
          memorySummary: episode.memorySummary || post.memorySummary,
          orderIndex: post.orderIndex,
        }
      : post,
  );
  const saved = await savePersonaArchive(withPlatformQueues(
    { ...archive, posts: nextPosts },
    (posts, platform) => platform === "threads"
      ? nextPosts
      : posts.map((post) => {
          const updated = nextPosts.find((item) => item.id === post.id);
          return updated || post;
        }),
  ));
  const savedPost = saved.posts.find((post) => post.id === episode.archivePostId);
  return savedPost ? archivePostsToEpisodes([savedPost])[0] : null;
}

export async function updateArchivePostMedia(
  archiveId: string,
  archivePostId: string,
  media: {
    imageUrl: string;
    imageHistory?: PersonaArchivePost["imageHistory"];
    updatedAt?: string;
  },
): Promise<PersonaArchivePost | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive || !archivePostId) return null;
  const now = media.updatedAt || new Date().toISOString();
  const updatePost = (post: PersonaArchivePost): PersonaArchivePost => post.id === archivePostId
    ? {
        ...post,
        imageUrl: media.imageUrl,
        imageHistory: media.imageHistory,
        updatedAt: now,
      }
    : post;
  const saved = await savePersonaArchive(withPlatformQueues(
    archive,
    (posts) => posts.map(updatePost),
  ));
  return saved.posts.find((post) => post.id === archivePostId) || null;
}

export async function updatePersonaArchivePostDraft(
  archiveId: string,
  archivePostId: string,
  patch: {
    content?: string;
    imageUrl?: string;
    mediaUrl?: string;
    mediaType?: PersonaArchivePost["mediaType"];
    mediaItems?: PersonaArchivePost["mediaItems"];
    sourceMetaPatch?: Partial<NonNullable<PersonaArchivePost["sourceMeta"]>>;
  },
): Promise<PersonaArchivePost | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive || !archivePostId) return null;
  const now = new Date().toISOString();
  const updatePost = (post: PersonaArchivePost): PersonaArchivePost => {
    if (post.id !== archivePostId) return post;
    const content = typeof patch.content === "string" ? patch.content.trim() : post.content;
    const mediaUrl = patch.mediaUrl !== undefined ? patch.mediaUrl : post.mediaUrl;
    const imageUrl = patch.imageUrl !== undefined ? patch.imageUrl : post.imageUrl;
    const mediaItems = patch.mediaItems !== undefined ? patch.mediaItems : post.mediaItems;
    const sourceMeta = patch.sourceMetaPatch
      ? { ...(post.sourceMeta || {}), ...patch.sourceMetaPatch }
      : post.sourceMeta;
    return {
      ...post,
      content,
      wordCount: content.length,
      imageUrl: imageUrl || undefined,
      mediaUrl,
      mediaType: patch.mediaType !== undefined ? patch.mediaType : post.mediaType,
      mediaItems,
      sourceMeta,
      updatedAt: now,
    };
  };
  const saved = await savePersonaArchive(withPlatformQueues(
    archive,
    (posts) => posts.map(updatePost),
  ));
  return saved.posts.find((post) => post.id === archivePostId) || null;
}

export async function deleteArchiveEpisode(
  archiveId: string,
  archivePostId: string,
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  return savePersonaArchive(withPlatformQueues(archive, (posts) => posts.filter((post) => post.id !== archivePostId)));
}

export async function deleteArchiveEpisodes(
  archiveId: string,
  archivePostIds: string[],
): Promise<PersonaArchive | null> {
  const ids = new Set(archivePostIds.filter(Boolean));
  if (ids.size === 0) return loadPersonaArchive(archiveId);
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  return savePersonaArchive(withPlatformQueues(archive, (posts) => posts.filter((post) => !ids.has(post.id))));
}

export async function replaceArchivePosts(
  archiveId: string,
  episodes: EpisodeScript[],
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  const nextPosts = replaceArchivePostsFromEpisodes(episodes);
  return savePersonaArchive(withPlatformQueues(
    { ...archive, posts: nextPosts },
    () => nextPosts,
  ));
}

export async function reorderArchivePosts(
  archiveId: string,
  orderedPostIds: string[],
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  return savePersonaArchive(withPlatformQueues(archive, (posts) => reorderArchivePostsByIds(posts, orderedPostIds)));
}

export async function requeuePublishRecord(
  archiveId: string,
  publishRecordId: string,
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  const record = (archive.publishHistory || []).find((item) => item.id === publishRecordId);
  if (!record || !record.content.trim()) return null;

  const now = new Date().toISOString();
  const nextOrderIndex = archive.posts.reduce(
    (max, post) => Math.max(max, post.orderIndex ?? -1),
    -1,
  ) + 1;

  const post = normalizePost(
    {
      id: crypto.randomUUID(),
      title: record.title || `重發推文 #${archive.posts.length + 1}`,
      content: record.content,
      wordCount: record.content.length,
      orderIndex: nextOrderIndex,
      createdAt: now,
      updatedAt: now,
      imageUrl: record.imageUrl,
      sourceMeta: record.sourceMeta,
      telegramGroupContentType: record.telegramGroupContentType,
    },
    nextOrderIndex,
  );

  return savePersonaArchive(withPlatformQueues(archive, (posts) => [...posts, post]));
}

export async function appendCustomPersonaArchivePost(args: {
  archiveId: string;
  content: string;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "unknown";
  mediaItems?: PersonaArchivePost["mediaItems"];
  sourceMeta?: {
    source?: string;
    platform?: string;
    sourceUrl?: string;
    hotScore?: number;
    metrics?: Record<string, unknown>;
    engagement?: Record<string, unknown>;
    publishedAt?: string;
    capturedAt?: string;
    warnings?: string[];
    originalContent?: string;
    originalMediaUrl?: string;
    originalMediaUrls?: string[];
    mediaItems?: PersonaArchivePost["mediaItems"];
    edited?: boolean;
  };
  title?: string;
  telegramGroupContentType?: "free" | "paid";
}): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(args.archiveId);
  if (!archive) return null;
  const content = args.content.trim();
  const now = new Date().toISOString();
  const nextOrderIndex = archive.posts.reduce(
    (max, post) => Math.max(max, post.orderIndex ?? -1),
    -1,
  ) + 1;

  const post = normalizePost(
    {
      id: crypto.randomUUID(),
      title: args.title || (content ? `自定义推文 #${archive.posts.length + 1}` : `自定义媒体 #${archive.posts.length + 1}`),
      content,
      wordCount: content.length,
      orderIndex: nextOrderIndex,
      createdAt: now,
      updatedAt: now,
      imageUrl: args.mediaUrl,
      mediaUrl: args.mediaUrl,
      mediaType: args.mediaType,
      mediaItems: args.mediaItems,
      sourceMeta: args.sourceMeta,
      telegramGroupContentType: args.telegramGroupContentType,
    },
    nextOrderIndex,
  );

  return savePersonaArchive(withPlatformQueues(archive, (posts) => [...posts, post]));
}

export async function markPersonaArchivePostTelegramGroupContentType(
  archiveId: string,
  archivePostId: string,
  telegramGroupContentType: "free" | "paid",
): Promise<PersonaArchive | null> {
  const archive = await loadPersonaArchive(archiveId);
  if (!archive || !archivePostId) return archive;
  return savePersonaArchive(withPlatformQueues(archive, (posts) => posts.map((post) =>
    post.id === archivePostId ? { ...post, telegramGroupContentType } : post,
  )));
}

export async function markArchiveEpisodesPublished(
  archiveId: string,
  archivePostIds: string[],
  publishedContentById: Record<string, string> = {},
  publishedMetaById: Record<string, PersonaPublishMeta> = {},
): Promise<PersonaArchive | null> {
  if (archivePostIds.length === 0) return null;
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  const idSet = new Set(archivePostIds);
  const publishedAt = new Date().toISOString();
  const publishPlatform = platformFromMeta(publishedMetaById);
  const sourcePosts = publishPlatform
    ? getArchivePendingPostsForPlatform(archive, publishPlatform)
    : archive.posts;
  const publishedPosts = sourcePosts.filter((post) => idSet.has(post.id));

  const getSentContent = (post: PersonaArchivePost) => {
    const sentContent = typeof publishedContentById[post.id] === "string"
      ? publishedContentById[post.id].trim()
      : "";
    return sentContent || post.content;
  };

  const publishedMemories = publishedPosts
    .map((post) => {
      const content = getSentContent(post);
      if (!content.trim()) return null;
      const summary = content === post.content && post.memorySummary
        ? buildArchiveMemoryOutline(post.memorySummary)
        : undefined;
      return { content, summary };
    })
    .filter(Boolean) as Array<{ content: string; summary?: string }>;

  const publishHistory = publishedPosts
    .map((post, index) => {
      const meta = publishedMetaById[post.id] || {};
      const content = getSentContent(post);
      return normalizePublishRecord({
        id: crypto.randomUUID(),
        archivePostId: post.id,
        title: post.title,
        content,
        wordCount: content.length,
        publishedAt,
        platform: meta.platform,
        padCode: meta.padCode,
        padName: meta.padName,
        imageUrl: meta.mediaUrl || meta.imageUrl || post.imageUrl,
        screenshotUrl: meta.screenshotUrl,
        telegramGroupContentType: post.telegramGroupContentType,
        sourceMeta: meta.sourceMeta || post.sourceMeta,
        publishedUrl: meta.publishedUrl,
        publishedMeta: meta.publishedMeta,
        publishedTargets: meta.publishedTargets,
      }, (archive.publishHistory?.length || 0) + index);
    })
    .filter((record) => record.content.trim());

  const writeMemories = async () => {
    for (const { content, summary } of publishedMemories) {
      await addPostToMemory(archive.id, content, archive.name, summary, archive.content);
    }
  };

  const nextArchiveBase = {
    ...archive,
    updatedAt: publishedAt,
    publishHistory: sortPublishHistory([
      ...(archive.publishHistory || []),
      ...publishHistory,
    ]),
  };
  const nextArchive = publishPlatform
    ? withPlatformQueues(nextArchiveBase, (posts, platform) =>
        platform === publishPlatform ? posts.filter((post) => !idSet.has(post.id)) : posts,
      )
    : withPlatformQueues(nextArchiveBase, (posts) => posts.filter((post) => !idSet.has(post.id)));

  if (!hasElectronMemoryAPI() && publishedMemories.length > 0) {
    await writeMemories();
  }

  const savedArchive = await savePersonaArchive(nextArchive);

  if (hasElectronMemoryAPI() && publishedMemories.length > 0) {
    void writeMemories().catch(() => undefined);
  }

  return savedArchive;
}

export async function markFavoritePostsPublished(
  archiveId: string,
  favoritePostIds: string[],
  publishedContentById: Record<string, string> = {},
  publishedMetaById: Record<string, PersonaPublishMeta> = {},
): Promise<PersonaArchive | null> {
  if (favoritePostIds.length === 0) return null;
  const archive = await loadPersonaArchive(archiveId);
  if (!archive) return null;
  const idSet = new Set(favoritePostIds);
  const publishedAt = new Date().toISOString();
  const publishedPosts = (archive.favoritePosts || []).filter((post) => idSet.has(post.id));

  const getSentContent = (post: PersonaArchivePost) => {
    const sentContent = typeof publishedContentById[post.id] === "string"
      ? publishedContentById[post.id].trim()
      : "";
    return sentContent || post.content;
  };

  const publishedMemories = publishedPosts
    .map((post) => {
      const content = getSentContent(post);
      if (!content.trim()) return null;
      const summary = content === post.content && post.memorySummary
        ? buildArchiveMemoryOutline(post.memorySummary)
        : undefined;
      return { content, summary };
    })
    .filter(Boolean) as Array<{ content: string; summary?: string }>;

  const publishHistory = publishedPosts
    .map((post, index) => {
      const meta = publishedMetaById[post.id] || {};
      const content = getSentContent(post);
      return normalizePublishRecord({
        id: crypto.randomUUID(),
        archivePostId: post.id,
        title: post.title,
        content,
        wordCount: content.length,
        publishedAt,
        platform: meta.platform,
        padCode: meta.padCode,
        padName: meta.padName,
        imageUrl: meta.mediaUrl || meta.imageUrl || post.imageUrl,
        screenshotUrl: meta.screenshotUrl,
        telegramGroupContentType: post.telegramGroupContentType,
        sourceMeta: meta.sourceMeta || post.sourceMeta,
        publishedUrl: meta.publishedUrl,
        publishedMeta: meta.publishedMeta,
        publishedTargets: meta.publishedTargets,
      }, (archive.publishHistory?.length || 0) + index);
    })
    .filter((record) => record.content.trim());

  const writeMemories = async () => {
    for (const { content, summary } of publishedMemories) {
      await addPostToMemory(archive.id, content, archive.name, summary, archive.content);
    }
  };

  const savedArchive = await savePersonaArchive({
    ...archive,
    updatedAt: publishedAt,
    favoritePosts: sortArchivePosts(archive.favoritePosts || []),
    publishHistory: sortPublishHistory([
      ...(archive.publishHistory || []),
      ...publishHistory,
    ]),
  });

  if (publishedMemories.length > 0) {
    if (hasElectronMemoryAPI()) void writeMemories().catch(() => undefined);
    else await writeMemories();
  }

  return savedArchive;
}
