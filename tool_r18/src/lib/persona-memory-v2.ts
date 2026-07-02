/**
 * src/lib/persona-memory-v2.ts
 * Memory service — now delegates to core/memory for pure logic.
 * Browser/Electron IPC paths removed; this is Node-first.
 */

export {
  buildArchivePostMemoryEntries,
  buildMemoryOutline,
  buildMemoryThumbnail,
  formatMemoryEntriesForPrompt,
  normalizeMemorySummaryForStorage,
  type ArchiveMemoryPostLike,
  type MemoryEntryPreview,
} from "@/core/memory/memory-format";

import {
  buildMemoryOutline,
  formatMemoryEntriesForPrompt,
  type MemoryEntryPreview,
} from "@/core/memory/memory-format";
import {
  addSummariesToMemoryAsync,
  deletePersonaMemoryAsync,
  deletePersonaMemoryEntryAsync,
  deletePersonaMemoryEntry,
  getPersonaMemoryAsync,
  replacePersonaMemoryEntries,
  type PersonaMemoryEntry,
} from "@/lib/persona-memory";
import {
  consolidatePersonaMemoryEntries,
  summarizePersonaPostMemory,
} from "@/lib/persona-memory-ai";

export interface MemoryStats {
  entryCount: number;
  entityCount: number;
  relCount: number;
  oldestDate?: string;
  newestDate?: string;
}

/** Stub — memory init is now handled by the memory skill directly */
export async function initPersonaMemory(
  _personaId: string,
  _personaName?: string,
): Promise<{ entryCount: number; entityCount: number }> {
  return { entryCount: 0, entityCount: 0 };
}

/** Stub — memory add is now handled by the memory skill directly */
export async function addPostToMemory(
  personaId: string,
  postContent: string,
  personaName?: string,
  summaryOverride?: string,
  personaContent?: string,
): Promise<void> {
  const electronMemory = typeof window !== "undefined" ? (window as any).electronAPI?.memory : undefined;
  if (electronMemory?.addEntry) {
    await electronMemory.addEntry({ personaId, personaName, postContent });
    return;
  }
  const summary = summaryOverride?.trim() || await summarizePersonaPostMemory({
    personaName,
    personaContent,
    postContent,
  });
  await addSummariesToMemoryAsync(personaId, [summary || buildMemoryOutline(postContent)]);
  await consolidateOldPersonaMemory(personaId, personaName, personaContent);
}

/** Stub — memory query is now handled by the memory skill directly */
export async function getMemoryForPrompt(
  personaId: string,
  _context: string,
): Promise<string> {
  const entries = await getMemoryEntries(personaId);
  return formatMemoryEntriesForPrompt(entries, 24);
}

export async function getMemoryStats(_personaId: string): Promise<MemoryStats> {
  return { entryCount: 0, entityCount: 0, relCount: 0 };
}

export async function getMemoryEntries(_personaId: string): Promise<MemoryEntryPreview[]> {
  return (await getPersonaMemoryAsync(_personaId)).entries;
}

export async function deleteMemoryEntry(
  personaId: string,
  entry: MemoryEntryPreview,
): Promise<void> {
  if (typeof window === "undefined") {
    await deletePersonaMemoryEntryAsync(personaId, entry as any);
    return;
  }
  deletePersonaMemoryEntry(personaId, entry as any);
}

export async function deleteMemory(personaId: string): Promise<void> {
  await deletePersonaMemoryAsync(personaId);
}

export async function summarizePostForMemory(input: {
  personaName?: string;
  personaContent?: string;
  postContent: string;
  sequenceNumber?: number;
}): Promise<string> {
  return summarizePersonaPostMemory(input);
}

export async function consolidateOldPersonaMemory(
  personaId: string,
  personaName?: string,
  personaContent?: string,
  now = new Date(),
): Promise<void> {
  const memory = await getPersonaMemoryAsync(personaId);
  const cutoff = now.getTime() - 60 * 24 * 60 * 60 * 1000;
  const oldEntries = memory.entries.filter((entry) => {
    if (entry.kind === "consolidated") return false;
    const time = new Date(entry.date).getTime();
    return Number.isFinite(time) && time < cutoff;
  });
  if (oldEntries.length === 0) return;

  const keepEntries = memory.entries.filter((entry) => !oldEntries.some((old) => old.id === entry.id));
  const grouped = new Map<string, PersonaMemoryEntry[]>();
  for (const entry of oldEntries) {
    const date = new Date(entry.date);
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const group = grouped.get(monthKey) || [];
    group.push(entry);
    grouped.set(monthKey, group);
  }

  const consolidated: PersonaMemoryEntry[] = [];
  for (const [monthKey, entries] of grouped.entries()) {
    const summary = await consolidatePersonaMemoryEntries({
      personaName,
      personaContent,
      entries,
    });
    if (!summary.trim()) continue;
    const sorted = [...entries].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    consolidated.push({
      id: `consolidated-${personaId}-${monthKey}-${Date.now()}`,
      date: sorted[sorted.length - 1]?.date || now.toISOString(),
      summary,
      kind: "consolidated",
      sourceCount: entries.length,
      rangeStart: sorted[0]?.date,
      rangeEnd: sorted[sorted.length - 1]?.date,
    });
  }

  await replacePersonaMemoryEntries(personaId, [...keepEntries, ...consolidated]);
}
