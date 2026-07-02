import { normalizeMemorySummaryForStorage, OUTLINE_MAX_LEN } from "@/core/memory/memory-format";

export interface PersonaMemoryEntry {
  id: string;
  date: string;
  summary: string;
  content?: string;
  kind?: "post" | "consolidated";
  sourceCount?: number;
  rangeStart?: string;
  rangeEnd?: string;
}

export interface PersonaMemory {
  personaId: string;
  entries: PersonaMemoryEntry[];
}

export const MAX_PERSONA_MEMORY_ENTRIES = 100;

const nodeMemory = new Map<string, PersonaMemoryEntry[]>();
let nodeMemoryLoaded = false;

async function getNodeMemoryFile(): Promise<string | null> {
  if (canUseLocalStorage()) return null;
  try {
    const { resolveRuntimeFile } = await import("@/runtime/node/data-dir");
    return resolveRuntimeFile("persona_memory.json");
  } catch {
    return null;
  }
}

async function readNodeMemoryFile(): Promise<Record<string, PersonaMemoryEntry[]>> {
  const file = await getNodeMemoryFile();
  if (!file) return {};
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([personaId, entries]) => [
        personaId,
        normalizeEntries(entries),
      ]),
    );
  } catch {
    return {};
  }
}

async function writeNodeMemoryFile(data: Record<string, PersonaMemoryEntry[]>): Promise<void> {
  const file = await getNodeMemoryFile();
  if (!file) return;
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function memoryKey(personaId: string) {
  return `persona_memory_${personaId}`;
}

function canUseLocalStorage() {
  return typeof window !== "undefined"
    && Boolean(window.localStorage)
    && !(window.localStorage as any).__nodeShim;
}

function normalizeEntries(value: unknown): PersonaMemoryEntry[] {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item && typeof item === "object" && typeof (item as any).summary === "string")
      .map((item, index) => {
        const rawSummary = typeof (item as any).summary === "string" ? (item as any).summary.replace(/\s+/g, " ").trim() : "";
        const summary = normalizeMemorySummaryForStorage(rawSummary);
        if (!summary) return null;
        const content = typeof (item as any).content === "string" && (item as any).content.trim()
          ? (item as any).content.replace(/\s+/g, " ").trim()
          : rawSummary && rawSummary !== summary && rawSummary.length <= OUTLINE_MAX_LEN
            ? rawSummary
            : undefined;
        return {
          id: typeof (item as any).id === "string" ? (item as any).id : `legacy-${index}`,
          date: typeof (item as any).date === "string" ? (item as any).date : new Date().toISOString(),
          summary,
          content,
          kind: (item as any).kind === "consolidated" ? "consolidated" : "post",
          sourceCount: typeof (item as any).sourceCount === "number" ? (item as any).sourceCount : undefined,
          rangeStart: typeof (item as any).rangeStart === "string" ? (item as any).rangeStart : undefined,
          rangeEnd: typeof (item as any).rangeEnd === "string" ? (item as any).rangeEnd : undefined,
        } satisfies PersonaMemoryEntry;
      })
      .filter(Boolean) as PersonaMemoryEntry[];
  }
  if (value && typeof value === "object" && Array.isArray((value as PersonaMemory).entries)) {
    return normalizeEntries((value as PersonaMemory).entries);
  }
  return [];
}

function entryRecencyScore(entry: PersonaMemoryEntry, index: number): number {
  const time = new Date(entry.date).getTime();
  return Number.isFinite(time) ? time : index;
}

function keepRecentEntries(entries: PersonaMemoryEntry[]): PersonaMemoryEntry[] {
  const normalized = normalizeEntries(entries);
  if (normalized.length <= MAX_PERSONA_MEMORY_ENTRIES) return normalized;
  const keepIndexes = new Set(
    normalized
      .map((entry, index) => ({ index, score: entryRecencyScore(entry, index) }))
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, MAX_PERSONA_MEMORY_ENTRIES)
      .map((item) => item.index),
  );
  return normalized.filter((_entry, index) => keepIndexes.has(index));
}

function readEntries(personaId: string): PersonaMemoryEntry[] {
  if (!canUseLocalStorage()) {
    return [...(nodeMemory.get(personaId) || [])];
  }
  try {
    const raw = window.localStorage.getItem(memoryKey(personaId));
    return normalizeEntries(raw ? JSON.parse(raw) : null);
  } catch {
    return [];
  }
}

function writeEntries(personaId: string, entries: PersonaMemoryEntry[]) {
  const nextEntries = keepRecentEntries(entries);
  if (!canUseLocalStorage()) {
    nodeMemory.set(personaId, nextEntries);
    return;
  }
  window.localStorage.setItem(memoryKey(personaId), JSON.stringify({ personaId, entries: nextEntries }));
}

async function readEntriesAsync(personaId: string): Promise<PersonaMemoryEntry[]> {
  if (canUseLocalStorage()) return readEntries(personaId);
  if (!nodeMemoryLoaded) {
    const data = await readNodeMemoryFile();
    Object.entries(data).forEach(([id, entries]) => nodeMemory.set(id, entries));
    nodeMemoryLoaded = true;
  }
  return [...(nodeMemory.get(personaId) || [])];
}

async function writeEntriesAsync(personaId: string, entries: PersonaMemoryEntry[]): Promise<void> {
  if (canUseLocalStorage()) {
    writeEntries(personaId, entries);
    return;
  }
  nodeMemory.set(personaId, keepRecentEntries(entries));
  await writeNodeMemoryFile(Object.fromEntries(nodeMemory.entries()));
}

function makeEntry(summary: string, index: number, content?: string): PersonaMemoryEntry {
  const date = new Date().toISOString();
  return {
    id: `${date}-${index}-${Math.random().toString(36).slice(2, 10)}`,
    date,
    summary,
    content,
  };
}

function memoryDedupeKey(summary: string): string {
  return normalizeMemorySummaryForStorage(String(summary || ""))
    .replace(/\s+/g, "")
    .toLowerCase();
}

function appendUniqueMemoryEntries(existing: PersonaMemoryEntry[], items: Array<{ summary: string; content?: string }>): PersonaMemoryEntry[] {
  const seen = new Set(existing.map((entry) => memoryDedupeKey(entry.summary)).filter(Boolean));
  const additions: PersonaMemoryEntry[] = [];
  for (const item of items) {
    const key = memoryDedupeKey(item.summary);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    additions.push(makeEntry(item.summary, additions.length, item.content));
  }
  return additions.length ? [...existing, ...additions] : existing;
}

export function getPersonaMemory(personaId: string): PersonaMemory {
  return {
    personaId,
    entries: readEntries(personaId),
  };
}

export function addSummariesToMemory(personaId: string, summaries: string[]) {
  const cleaned = summaries
    .map((summary) => {
      const raw = String(summary || "").replace(/\s+/g, " ").trim();
      const compact = normalizeMemorySummaryForStorage(raw);
      return compact ? { summary: compact, content: raw && raw !== compact && raw.length <= OUTLINE_MAX_LEN ? raw : undefined } : null;
    })
    .filter(Boolean) as Array<{ summary: string; content?: string }>;
  if (cleaned.length === 0) return;
  const existing = readEntries(personaId);
  writeEntries(personaId, appendUniqueMemoryEntries(existing, cleaned));
}

export async function addSummariesToMemoryAsync(
  personaId: string,
  summaries: string[],
  entryOptions: Partial<Pick<PersonaMemoryEntry, "kind" | "sourceCount" | "rangeStart" | "rangeEnd">> = {},
) {
  const cleaned = summaries
    .map((summary) => {
      const raw = String(summary || "").replace(/\s+/g, " ").trim();
      const compact = normalizeMemorySummaryForStorage(raw);
      return compact ? { summary: compact, content: raw && raw !== compact && raw.length <= OUTLINE_MAX_LEN ? raw : undefined } : null;
    })
    .filter(Boolean) as Array<{ summary: string; content?: string }>;
  if (cleaned.length === 0) return;
  const existing = await readEntriesAsync(personaId);
  const seen = new Set(existing.map((entry) => memoryDedupeKey(entry.summary)).filter(Boolean));
  const additions: PersonaMemoryEntry[] = [];
  for (const item of cleaned) {
    const key = memoryDedupeKey(item.summary);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    additions.push({
      ...makeEntry(item.summary, additions.length, item.content),
      kind: entryOptions.kind || "post",
      sourceCount: entryOptions.sourceCount,
      rangeStart: entryOptions.rangeStart,
      rangeEnd: entryOptions.rangeEnd,
    });
  }
  if (additions.length === 0) return;
  await writeEntriesAsync(personaId, [...existing, ...additions]);
}

export async function replacePersonaMemoryEntries(
  personaId: string,
  entries: PersonaMemoryEntry[],
): Promise<void> {
  await writeEntriesAsync(personaId, normalizeEntries(entries));
}

export function deletePersonaMemoryEntry(
  personaId: string,
  selector: Partial<PersonaMemoryEntry>,
): boolean {
  const entries = readEntries(personaId);
  const next = entries.filter((entry) => !matchesEntrySelector(entry, selector));
  if (next.length === entries.length) return false;
  writeEntries(personaId, next);
  return true;
}

function matchesEntrySelector(entry: PersonaMemoryEntry, selector: Partial<PersonaMemoryEntry>): boolean {
  if (selector.id && entry.id === selector.id) return true;
  const selectorSummary = selector.summary ? normalizeMemorySummaryForStorage(selector.summary) : "";
  if (selector.date && selectorSummary && entry.date === selector.date && entry.summary === selectorSummary) return true;
  if (!selector.id && !selector.date && selectorSummary && entry.summary === selectorSummary) return true;
  return false;
}

export async function deletePersonaMemoryEntryAsync(
  personaId: string,
  selector: Partial<PersonaMemoryEntry>,
): Promise<boolean> {
  const entries = await readEntriesAsync(personaId);
  const next = entries.filter((entry) => !matchesEntrySelector(entry, selector));
  if (next.length === entries.length) return false;
  await writeEntriesAsync(personaId, next);
  return true;
}

export function deletePersonaMemory(personaId: string) {
  nodeMemory.delete(personaId);
  if (canUseLocalStorage()) {
    window.localStorage.removeItem(memoryKey(personaId));
  }
}

export async function deletePersonaMemoryAsync(personaId: string): Promise<void> {
  if (canUseLocalStorage()) {
    deletePersonaMemory(personaId);
    return;
  }

  const data = await readNodeMemoryFile();
  delete data[personaId];
  nodeMemory.clear();
  Object.entries(data).forEach(([id, entries]) => nodeMemory.set(id, entries));
  nodeMemoryLoaded = true;
  await writeNodeMemoryFile(data);
}

export async function getPersonaMemoryAsync(personaId: string): Promise<PersonaMemory> {
  return {
    personaId,
    entries: await readEntriesAsync(personaId),
  };
}
