import type { DramaSetup, EpisodeScript } from "@/types/drama";
import { sanitizeGeneratedPostContent } from "@/core/persona/generated-post-parser";

export type ArchiveSetup = Partial<DramaSetup> & {
  _regionHint?: string;
  isMemePersona?: boolean;
  isGirlPersona?: boolean;
  personaImageReferenceUrl?: string;
  personaImageSkipped?: boolean;
  tweetStyleProfile?: string;
  tweetStyleSample?: string;
  tweetStyleLinkUrl?: string;
  tweetStyleLinkText?: string;
  tweetStyleUpdatedAt?: string;
  linkEndingPresets?: Array<{
    id: string;
    name?: string;
    linkUrl?: string;
    endingText?: string;
    enabled?: boolean;
    createdAt?: string;
    updatedAt?: string;
  }>;
  activeLinkEndingPresetId?: string;
  hotMetrics?: Record<string, {
    platform?: string;
    padCode?: string;
    username?: string;
    followers?: number;
    following?: number;
    recentViews?: number;
    likes?: number;
    comments?: number;
    reposts?: number;
    shares?: number;
    views?: number;
    posts?: number;
    scannedPosts?: number;
    complete?: boolean;
    scope?: string;
    lightRefreshedAt?: string;
    postMetrics?: Array<{
      pk?: string;
      code?: string;
      sourceUrl: string;
      content?: string;
      publishedAt?: string;
      likeCount?: number;
      commentCount?: number;
      repostCount?: number;
      shareCount?: number;
      viewCount?: number;
      capturedAt?: string;
    }>;
    refreshedAt?: string;
    error?: string;
  }>;
  accountManagement?: {
    threads?: {
      handle?: string;
      authProfileKey?: string;
      authProfileBoundAt?: string;
      password?: string;
      passwordSet?: boolean;
      updatedAt?: string;
    };
    telegram?: {
      phone?: string;
      email?: string;
      password?: string;
      passwordSet?: boolean;
      updatedAt?: string;
    };
  };
};

export interface PersonaArchivePost {
  id: string;
  title: string;
  content: string;
  wordCount: number;
  orderIndex?: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  publishedMemory?: string;
  memorySummary?: string;
  imageUrl?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video" | "unknown";
  mediaItems?: Array<{
    url: string;
    type?: "image" | "video" | "unknown";
    localPath?: string;
  }>;
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
    mediaItems?: Array<{
      url: string;
      type?: "image" | "video" | "unknown";
      localPath?: string;
    }>;
    edited?: boolean;
  };
  imageHistory?: EpisodeScript["imageHistory"];
  history?: EpisodeScript["history"];
  telegramGroupContentType?: "free" | "paid";
}

export interface PersonaImageLibraryItem {
  id: string;
  imageUrl: string;
  createdAt: string;
  prompt?: string;
  mode?: "workflow" | "closed-model";
  source?: "portrait" | "lifestyle" | "scene" | "pov" | "manual-upload";
  aspectRatio?: string;
  notes?: string;
}

export interface PersonaPublishRecord {
  id: string;
  archivePostId?: string;
  title: string;
  content: string;
  wordCount: number;
  publishedAt: string;
  platform?: string;
  padCode?: string;
  padName?: string;
  imageUrl?: string;
  screenshotUrl?: string;
  telegramGroupContentType?: "free" | "paid";
  sourceMeta?: PersonaArchivePost["sourceMeta"];
  publishedUrl?: string;
  publishedMeta?: PersonaArchivePost["sourceMeta"];
  publishedTargets?: PersonaPublishTarget[];
}

export interface PersonaPublishTarget {
  platform?: string;
  padCode?: string;
  padName?: string;
  publishedUrl?: string;
  publishedMeta?: PersonaArchivePost["sourceMeta"];
  screenshotUrl?: string;
}

export interface PersonaPublishMeta {
  platform?: string;
  padCode?: string;
  padName?: string;
  mediaUrl?: string;
  imageUrl?: string;
  screenshotUrl?: string;
  sourceMeta?: PersonaArchivePost["sourceMeta"];
  publishedUrl?: string;
  publishedMeta?: PersonaArchivePost["sourceMeta"];
  publishedTargets?: PersonaPublishTarget[];
}

export interface PersonaArchive {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  setup?: ArchiveSetup;
  boundPadCode?: string;
  boundPadName?: string;
  boundTelegramChatId?: string;
  boundTelegramFreeGroupId?: string;
  boundTelegramPaidGroupId?: string;
  boundTelegramFreeGroupName?: string;
  boundTelegramPaidGroupName?: string;
  ownerBotName?: string;
  posts: PersonaArchivePost[];
  favoritePosts?: PersonaArchivePost[];
  platformPosts?: Record<string, PersonaArchivePost[]>;
  publishHistory?: PersonaPublishRecord[];
  personaImageLibrary?: PersonaImageLibraryItem[];
  personaReferenceSheet?: string;
}

function toIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

export function sortArchivePosts(posts: PersonaArchivePost[]): PersonaArchivePost[] {
  return [...posts].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER);
    if (orderDiff !== 0) return orderDiff;
    const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (createdDiff !== 0) return createdDiff;
    return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  });
}

export function sortPublishHistory(records: PersonaPublishRecord[]): PersonaPublishRecord[] {
  return [...records].sort((a, b) => {
    const publishedDiff = new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    if (publishedDiff !== 0) return publishedDiff;
    return a.title.localeCompare(b.title, "zh-TW");
  });
}

export function buildArchivePostFromEpisode(ep: EpisodeScript, index: number): PersonaArchivePost {
  const now = new Date().toISOString();
  const createdAt = toIso(ep.createdAt, now);
  const updatedAt = toIso(ep.updatedAt, now);
  const content = sanitizeGeneratedPostContent(ep.content || "");
  return {
    id: ep.archivePostId || crypto.randomUUID(),
    title: ep.title || `貼文 #${index + 1}`,
    content,
    wordCount: ep.wordCount || content.length,
    orderIndex: ep.orderIndex ?? index,
    createdAt,
    updatedAt,
    publishedAt: ep.publishedAt,
    publishedMemory: ep.publishedAt ? ep.content || "" : undefined,
    memorySummary: ep.memorySummary,
    imageUrl: ep.imageUrl,
    imageHistory: ep.imageHistory,
    history: ep.history,
    telegramGroupContentType: (ep as any).telegramGroupContentType === "paid" ? "paid" : (ep as any).telegramGroupContentType === "free" ? "free" : undefined,
  };
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
    telegramGroupContentType: post.telegramGroupContentType,
  }));
}

export function appendEpisodesToArchivePosts(
  existingPosts: PersonaArchivePost[],
  episodes: EpisodeScript[],
): { posts: PersonaArchivePost[]; appended: PersonaArchivePost[] } {
  const nextOrderIndex = existingPosts.reduce(
    (max, post) => Math.max(max, post.orderIndex ?? -1),
    -1,
  ) + 1;
  const appended = episodes.map((ep, index) => buildArchivePostFromEpisode({
    ...ep,
    orderIndex: nextOrderIndex + index,
  }, existingPosts.length + index));
  return {
    posts: [...existingPosts, ...appended],
    appended,
  };
}

export function replaceArchivePostsFromEpisodes(episodes: EpisodeScript[]): PersonaArchivePost[] {
  return episodes.map((ep, index) => buildArchivePostFromEpisode(ep, index));
}

export function reorderArchivePostsByIds(posts: PersonaArchivePost[], orderedPostIds: string[]): PersonaArchivePost[] {
  const orderedSet = new Set(orderedPostIds);
  const knownPosts = orderedPostIds
    .map((id) => posts.find((post) => post.id === id))
    .filter(Boolean) as PersonaArchivePost[];
  const remainingPosts = sortArchivePosts(posts).filter((post) => !orderedSet.has(post.id));
  return [...knownPosts, ...remainingPosts].map((post, index) => ({
    ...post,
    orderIndex: index,
    updatedAt: new Date().toISOString(),
  }));
}
