import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ReaderResponseCacheMode = "swr" | "blocking-refresh" | "bypass";

export interface ReaderResponseSnapshot {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface ReaderResponseCacheEntry {
  cachedAt: number;
  value: ReaderResponseSnapshot;
}

interface ReaderResponseCoordinatorOptions {
  freshTtlMs?: number;
  staleTtlMs?: number;
  maxEntries?: number;
  storageDir?: string;
  now?: () => number;
}

interface ReaderResponseLoadOptions {
  mode?: ReaderResponseCacheMode;
  isCacheable?: (value: ReaderResponseSnapshot) => boolean;
}

const DEFAULT_FRESH_TTL_MS = 5 * 60_000;
const DEFAULT_STALE_TTL_MS = 10 * 60_000;

export class ReaderResponseCoordinator {
  private readonly freshTtlMs: number;
  private readonly staleTtlMs: number;
  private readonly maxEntries: number;
  private readonly storageDir?: string;
  private readonly now: () => number;
  private readonly memory = new Map<string, ReaderResponseCacheEntry>();
  private readonly inFlight = new Map<string, Promise<ReaderResponseSnapshot>>();

  constructor(options: ReaderResponseCoordinatorOptions = {}) {
    this.freshTtlMs = Math.max(0, Number(options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS));
    this.staleTtlMs = Math.max(0, Number(options.staleTtlMs ?? DEFAULT_STALE_TTL_MS));
    this.maxEntries = Math.max(1, Number(options.maxEntries ?? 200));
    this.storageDir = options.storageDir;
    this.now = options.now || Date.now;
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<ReaderResponseSnapshot>,
    options: ReaderResponseLoadOptions = {},
  ): Promise<ReaderResponseSnapshot> {
    const mode = options.mode || "swr";
    if (mode === "bypass") return loader();

    const cached = this.readEntry(key);
    const ageMs = cached ? Math.max(0, this.now() - cached.cachedAt) : Number.POSITIVE_INFINITY;
    if (mode === "swr" && cached && ageMs <= this.freshTtlMs) return cached.value;

    if (mode === "swr" && cached && ageMs <= this.freshTtlMs + this.staleTtlMs) {
      this.startLoad(key, loader, cached, options.isCacheable).catch(() => undefined);
      return cached.value;
    }

    return this.startLoad(key, loader, cached, options.isCacheable);
  }

  clearMemory() {
    this.memory.clear();
    this.inFlight.clear();
  }

  private startLoad(
    key: string,
    loader: () => Promise<ReaderResponseSnapshot>,
    cached: ReaderResponseCacheEntry | null,
    isCacheable: ReaderResponseLoadOptions["isCacheable"],
  ): Promise<ReaderResponseSnapshot> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = loader()
      .then((value) => {
        if (!isCacheable || isCacheable(value)) {
          this.writeEntry(key, { cachedAt: this.now(), value });
          return value;
        }
        return cached?.value || value;
      })
      .catch((error) => {
        if (cached && this.now() - cached.cachedAt <= this.freshTtlMs + this.staleTtlMs) {
          return cached.value;
        }
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private readEntry(key: string): ReaderResponseCacheEntry | null {
    const memoryEntry = this.memory.get(key);
    if (memoryEntry) {
      this.memory.delete(key);
      this.memory.set(key, memoryEntry);
      return memoryEntry;
    }
    if (!this.storageDir) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile(key), "utf8")) as ReaderResponseCacheEntry;
      if (!this.isValidEntry(parsed)) return null;
      this.remember(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private writeEntry(key: string, entry: ReaderResponseCacheEntry) {
    this.remember(key, entry);
    if (!this.storageDir) return;
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const file = this.cacheFile(key);
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(entry), "utf8");
      fs.rmSync(file, { force: true });
      fs.renameSync(temp, file);
    } catch {
      // The response remains available in memory when the shared cache is busy.
    }
  }

  private remember(key: string, entry: ReaderResponseCacheEntry) {
    this.memory.delete(key);
    this.memory.set(key, entry);
    while (this.memory.size > this.maxEntries) {
      const oldestKey = this.memory.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.memory.delete(oldestKey);
    }
  }

  private cacheFile(key: string): string {
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.storageDir || "", `${digest}.json`);
  }

  private isValidEntry(value: ReaderResponseCacheEntry): boolean {
    return Boolean(
      value
      && Number.isFinite(Number(value.cachedAt))
      && value.value
      && typeof value.value.body === "string"
      && Number.isFinite(Number(value.value.status))
      && value.value.headers
      && typeof value.value.headers === "object",
    );
  }
}

export function createReaderResponseCoordinator(options: ReaderResponseCoordinatorOptions = {}) {
  return new ReaderResponseCoordinator(options);
}
