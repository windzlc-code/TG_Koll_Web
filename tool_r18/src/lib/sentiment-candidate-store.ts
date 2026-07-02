import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

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

type StoreState = {
  shown: Record<string, Array<string | { id: string; at?: string }>>;
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
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export function buildSentimentCandidateId(input: { platform: string; sourceUrl?: string; content?: string }): string {
  const stable = [input.platform, input.sourceUrl || "", input.content || ""].join("\n");
  return crypto.createHash("sha1").update(stable).digest("hex").slice(0, 20);
}

export function getSentimentHotExcludedIds(archiveId: string): Set<string> {
  const state = readState();
  return new Set([
    ...(state.selected[archiveId] || []),
    ...(state.imported[archiveId] || []),
  ]);
}

function shownEntryId(entry: string | { id: string; at?: string }): string {
  return typeof entry === "string" ? entry : String(entry?.id || "");
}

export function getSentimentHotRefreshExcludedIds(archiveId: string): Set<string> {
  const state = readState();
  return new Set([
    ...(state.shown[archiveId] || []).map(shownEntryId).filter(Boolean),
    ...(state.selected[archiveId] || []),
    ...(state.imported[archiveId] || []),
  ]);
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
  const state = readState();
  const now = new Date().toISOString();
  const current = new Map<string, { id: string; at: string }>();
  for (const entry of state.shown[archiveId] || []) {
    const id = shownEntryId(entry);
    if (!id) continue;
    const at = typeof entry === "string" ? "" : String(entry.at || "");
    current.set(id, { id, at });
  }
  for (const candidate of candidates) current.set(candidate.id, { id: candidate.id, at: now });
  state.shown[archiveId] = [...current.values()].slice(-500);
  writeState(state);
}

export function rememberSentimentHotSelected(archiveId: string, candidateId: string) {
  const state = readState();
  const selected = new Set(state.selected[archiveId] || []);
  selected.add(candidateId);
  state.selected[archiveId] = [...selected].slice(-500);
  writeState(state);
}

export function rememberSentimentHotImported(archiveId: string, candidateId: string) {
  const state = readState();
  const imported = new Set(state.imported[archiveId] || []);
  imported.add(candidateId);
  state.imported[archiveId] = [...imported].slice(-500);
  writeState(state);
}
