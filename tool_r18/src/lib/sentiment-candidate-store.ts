import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";
import { withExclusiveJsonFileLock } from "@/runtime/node/json-file-lock";

export type SentimentHotPlatform = "threads" | "instagram";
export type SentimentHotMediaType = "image" | "video" | "unknown";

export interface SentimentHotMedia {
  type: SentimentHotMediaType;
  url: string;
  thumbnailUrl?: string;
  localPath?: string;
  warning?: string;
}

export interface SentimentHotCandidate {
  id: string;
  platform: SentimentHotPlatform;
  sourceUrl: string;
  author: string;
  content: string;
  media: SentimentHotMedia[];
  hotScore: number;
  /** Canonical API-facing view count. Omitted when the source does not expose it. */
  view_count?: number;
  /** Accepted from camelCase collector payloads and normalized before display. */
  viewCount?: number;
  views?: number;
  metrics: Record<string, unknown>;
  engagement?: {
    likeCount?: number;
    commentCount?: number;
    viewCount?: number;
    shareCount?: number;
    rawSignals?: number[];
  };
  publishedAt?: string;
  capturedAt: string;
  warnings?: string[];
  qaPassed?: boolean;
}

type ShownEntry = { id: string; at?: string; urlKey?: string; contentKey?: string };

type StoreState = {
  shown: Record<string, Array<string | ShownEntry>>;
  selected: Record<string, string[]>;
  imported: Record<string, string[]>;
};

type SentimentHotSearchMode = "normal" | "strict";

function sentimentHotHistoryScope(archiveId: string, searchMode?: SentimentHotSearchMode): string {
  const cleanArchiveId = String(archiveId || "").trim() || "default";
  return searchMode === "normal" || searchMode === "strict"
    ? `${cleanArchiveId}::${searchMode}`
    : cleanArchiveId;
}

const STORE_FILE = resolveRuntimeFile("sentiment_hot_candidates.json");

function emptyState(): StoreState {
  return { shown: {}, selected: {}, imported: {} };
}

function readState(): StoreState {
  try {
    if (!fs.existsSync(STORE_FILE)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      shown: parsed?.shown && typeof parsed.shown === "object" ? parsed.shown : {},
      selected: parsed?.selected && typeof parsed.selected === "object" ? parsed.selected : {},
      imported: parsed?.imported && typeof parsed.imported === "object" ? parsed.imported : {},
    };
  } catch {
    return emptyState();
  }
}

function writeState(state: StoreState) {
  const temporaryPath = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporaryPath, STORE_FILE);
}

function updateState(mutator: (state: StoreState) => void) {
  const updated = withExclusiveJsonFileLock(STORE_FILE, () => {
    const state = readState();
    mutator(state);
    writeState(state);
  });
  if (!updated) throw new Error("热点候选状态正在更新，请稍后重试。");
}

export function buildSentimentCandidateId(input: { platform: string; sourceUrl?: string; content?: string }): string {
  const stable = [input.platform, input.sourceUrl || "", input.content || ""].join("\n");
  return crypto.createHash("sha1").update(stable).digest("hex").slice(0, 20);
}

export function getSentimentHotExcludedIds(_archiveId: string): Set<string> {
  // Import history is an audit trail, not a permanent queue blacklist. The
  // shown-history scope is responsible for short-term rotation/cooldown;
  // otherwise an imported post could never return to the candidate pool.
  return new Set<string>();
}

function shownEntryId(entry: string | ShownEntry): string {
  return typeof entry === "string" ? entry : String(entry?.id || "");
}

function historyUrlKey(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hostname = host === "threads.com" || host === "threads.net" ? "threads.net" : host;
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return text.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function historyContentKey(value: unknown): string {
  const text = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  return text ? crypto.createHash("sha1").update(text.slice(0, 500)).digest("hex") : "";
}

export function getSentimentHotCandidateHistoryKeys(candidate: Partial<SentimentHotCandidate>): string[] {
  const keys = new Set<string>();
  if (candidate.id) keys.add(`id:${candidate.id}`);
  const urlKey = historyUrlKey(candidate.sourceUrl);
  const contentKey = historyContentKey(candidate.content);
  if (urlKey) keys.add(`url:${urlKey}`);
  if (contentKey) keys.add(`content:${contentKey}`);
  return [...keys];
}

export function getSentimentHotShownHistoryKeys(archiveId: string, searchMode?: SentimentHotSearchMode): Set<string> {
  const keys = new Set<string>();
  for (const entry of readState().shown[sentimentHotHistoryScope(archiveId, searchMode)] || []) {
    const id = shownEntryId(entry);
    if (id) keys.add(`id:${id}`);
    if (typeof entry === "string") continue;
    if (entry.urlKey) keys.add(`url:${entry.urlKey}`);
    if (entry.contentKey) keys.add(`content:${entry.contentKey}`);
  }
  return keys;
}

export function getSentimentHotRefreshExcludedIds(archiveId: string, searchMode?: SentimentHotSearchMode): Set<string> {
  const state = readState();
  const historyScope = sentimentHotHistoryScope(archiveId, searchMode);
  return new Set([
    ...(state.shown[historyScope] || []).map(shownEntryId).filter(Boolean),
  ]);
}

export function getSentimentHotShownIds(archiveId: string, searchMode?: SentimentHotSearchMode): Set<string> {
  const state = readState();
  return new Set((state.shown[sentimentHotHistoryScope(archiveId, searchMode)] || []).map(shownEntryId).filter(Boolean));
}

export function getSentimentHotShownAtMap(archiveId: string, searchMode?: SentimentHotSearchMode): Map<string, number> {
  const state = readState();
  const result = new Map<string, number>();
  for (const entry of state.shown[sentimentHotHistoryScope(archiveId, searchMode)] || []) {
    const id = shownEntryId(entry);
    if (!id) continue;
    const at = typeof entry === "string" ? "" : String(entry.at || "");
    const time = Date.parse(at);
    result.set(id, Number.isFinite(time) ? time : 0);
  }
  return result;
}

export function getSentimentHotShownHistoryAtMap(archiveId: string, searchMode?: SentimentHotSearchMode): Map<string, number> {
  const state = readState();
  const result = new Map<string, number>();
  for (const entry of state.shown[sentimentHotHistoryScope(archiveId, searchMode)] || []) {
    const id = shownEntryId(entry);
    if (!id) continue;
    const at = typeof entry === "string" ? "" : String(entry.at || "");
    const time = Date.parse(at);
    const shownAt = Number.isFinite(time) ? time : 0;
    const keys = typeof entry === "string"
      ? [`id:${id}`]
      : [
          `id:${id}`,
          entry.urlKey ? `url:${entry.urlKey}` : "",
          entry.contentKey ? `content:${entry.contentKey}` : "",
        ].filter(Boolean);
    for (const key of keys) {
      const previous = result.get(key);
      if (previous === undefined || shownAt > previous) result.set(key, shownAt);
    }
  }
  return result;
}

export function rememberSentimentHotShown(archiveId: string, candidates: SentimentHotCandidate[], searchMode?: SentimentHotSearchMode) {
  updateState((state) => {
    const historyScope = sentimentHotHistoryScope(archiveId, searchMode);
    const now = new Date().toISOString();
    const current = new Map<string, ShownEntry>();
    for (const entry of state.shown[historyScope] || []) {
      const id = shownEntryId(entry);
      if (!id) continue;
      const at = typeof entry === "string" ? "" : String(entry.at || "");
      current.set(id, typeof entry === "string" ? { id, at } : { ...entry, id, at });
    }
    for (const candidate of candidates) {
      current.set(candidate.id, {
        id: candidate.id,
        at: now,
        urlKey: historyUrlKey(candidate.sourceUrl) || undefined,
        contentKey: historyContentKey(candidate.content) || undefined,
      });
    }
    state.shown[historyScope] = [...current.values()].slice(-2000);
  });
}

export function rememberSentimentHotSelected(archiveId: string, candidateId: string) {
  updateState((state) => {
    const selected = new Set(state.selected[archiveId] || []);
    selected.add(candidateId);
    state.selected[archiveId] = [...selected].slice(-500);
  });
}

export function forgetSentimentHotShown(archiveId: string, candidateIds: string[], searchMode?: SentimentHotSearchMode) {
  const forget = new Set((candidateIds || []).map((item) => String(item || "").trim()).filter(Boolean));
  if (!forget.size) return;
  updateState((state) => {
    const historyScope = sentimentHotHistoryScope(archiveId, searchMode);
    state.shown[historyScope] = (state.shown[historyScope] || []).filter((entry) => !forget.has(shownEntryId(entry)));
  });
}

export function rememberSentimentHotImported(archiveId: string, candidateId: string) {
  updateState((state) => {
    const imported = new Set(state.imported[archiveId] || []);
    imported.add(candidateId);
    state.imported[archiveId] = [...imported].slice(-500);
  });
}
