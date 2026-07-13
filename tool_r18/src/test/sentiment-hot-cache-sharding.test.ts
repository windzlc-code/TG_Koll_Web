import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeDirs: string[] = [];

afterEach(() => {
  delete process.env.TOOL_R18_RUNTIME_DIR;
  vi.resetModules();
  for (const dir of runtimeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sentiment hot cache sharding", () => {
  it("migrates the legacy cache into persona mode shards", async () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiment-hot-cache-"));
    runtimeDirs.push(runtimeDir);
    process.env.TOOL_R18_RUNTIME_DIR = runtimeDir;
    const candidate = {
      id: "candidate-1",
      platform: "threads",
      sourceUrl: "https://www.threads.net/@demo/post/1",
      author: "demo",
      content: "汽车维修保养经验与修车费用案例分享。".repeat(8),
      media: [],
      hotScore: 5000,
      metrics: {},
      capturedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(runtimeDir, "sentiment_threads_search_cache.json"), JSON.stringify({
      "persona-1::strict::汽车维修": { at: new Date().toISOString(), version: 5, candidates: [candidate] },
      "persona-1::normal::汽车生活": { at: new Date().toISOString(), version: 5, candidates: [{ ...candidate, id: "candidate-2" }] },
    }), "utf8");
    const shardDir = path.join(runtimeDir, "sentiment_threads_search_cache");
    fs.mkdirSync(shardDir, { recursive: true });
    const strictShard = path.join(shardDir, `persona-1-${crypto.createHash("sha1").update("persona-1").digest("hex").slice(0, 10)}-strict.json`);
    fs.writeFileSync(strictShard, JSON.stringify({
      "persona-1::strict::汽车维修": {
        at: new Date().toISOString(),
        version: 5,
        candidates: [{
          ...candidate,
          id: "candidate-existing",
          sourceUrl: "https://www.threads.net/@demo/post/existing",
          content: "汽车发动机维修诊断与零件更换经验。".repeat(8),
        }],
      },
    }), "utf8");

    const { listSentimentHotCandidatePoolStats } = await import("@/lib/sentiment-hot-importer");
    listSentimentHotCandidatePoolStats();

    const shardFiles = fs.readdirSync(shardDir).filter((name) => name.endsWith(".json"));
    expect(shardFiles).toHaveLength(2);
    expect(shardFiles.some((name) => name.endsWith("-strict.json"))).toBe(true);
    expect(shardFiles.some((name) => name.endsWith("-normal.json"))).toBe(true);
    const migratedKeys = shardFiles.flatMap((name) => Object.keys(JSON.parse(fs.readFileSync(path.join(shardDir, name), "utf8"))));
    expect(migratedKeys.sort()).toEqual([
      "persona-1::normal::汽车生活",
      "persona-1::strict::汽车维修",
    ]);
    const strictState = JSON.parse(fs.readFileSync(strictShard, "utf8"));
    expect(strictState["persona-1::strict::汽车维修"].candidates.map((item: { id: string }) => item.id).sort()).toEqual([
      "candidate-1",
      "candidate-existing",
    ]);
    expect(fs.existsSync(path.join(shardDir, ".legacy-migrated"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "sentiment_threads_search_cache.json"))).toBe(false);
    expect(fs.readdirSync(runtimeDir).some((name) => name.startsWith("sentiment_threads_search_cache.json.migrated-"))).toBe(true);
  });
});
