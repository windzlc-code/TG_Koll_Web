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

export function getSentimentHotExcludedIds(archiveId: string): Set<string> {
  const state = readState();
  return new Set(state.imported[archiveId] || []);
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

export function getSentimentHotShownHistoryKeys(archiveId: string): Set<string> {
  // Previewing candidates, including automated tests, must not consume them.
  // Existing shown records are presentation history only and are intentionally
  // excluded from refresh deduplication.
  void archiveId;
  return new Set<string>();
}

export function getSentimentHotRefreshExcludedIds(archiveId: string): Set<string> {
  return getSentimentHotExcludedIds(archiveId);
}

export function getSentimentHotShownIds(archiveId: string): Set<string> {
  const state = readState();
  return new Set((state.shown[archiveId] || []).map(shownEntryId).filter(Boolean));
}

export function getSentimentHotShownAtMap(archiveId: string): Map<string, number> {
  const state = readState();
  const result = new Map<string, number>();
  for (const entry of state.shown[archiveId] || []) {
    const id = shownEntryId(entry);
    if (!id) continue;
    const at = typeof entry === "string" ? "" : String(entry.at || "");
    const time = Date.parse(at);
    result.set(id, Number.isFinite(time) ? time : 0);
  }
  return result;
}

export function rememberSentimentHotShown(archiveId: string, candidates: SentimentHotCandidate[]) {
  updateState((state) => {
    const now = new Date().toISOString();
    const current = new Map<string, ShownEntry>();
    for (const entry of state.shown[archiveId] || []) {
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
    state.shown[archiveId] = [...current.values()].slice(-2000);
  });
}

export function rememberSentimentHotSelected(archiveId: string, candidateId: string) {
  updateState((state) => {
    const selected = new Set(state.selected[archiveId] || []);
    selected.add(candidateId);
    state.selected[archiveId] = [...selected].slice(-500);
  });
}

export function rememberSentimentHotImported(archiveId: string, candidateId: string) {
  updateState((state) => {
    const imported = new Set(state.imported[archiveId] || []);
    imported.add(candidateId);
    state.imported[archiveId] = [...imported].slice(-500);
  });
}
