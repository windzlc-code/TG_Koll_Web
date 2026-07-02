// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeRoot = path.join(os.tmpdir(), `persona-memory-node-${process.pid}`);

vi.mock("@/runtime/node/data-dir", () => ({
  resolveRuntimeFile: (name: string) => path.join(runtimeRoot, name),
}));

describe("persona memory node persistence", () => {
  beforeEach(async () => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
    vi.resetModules();
  });

  it("persists node memory entries to the runtime json file", async () => {
    const memory = await import("@/lib/persona-memory");

    await memory.addSummariesToMemoryAsync("persona-a", ["第1章：去日本旅行"]);

    const file = path.join(runtimeRoot, "persona_memory.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(persisted["persona-a"][0].summary).toBe("第1章：去日本旅行");

    vi.resetModules();
    const reloaded = await import("@/lib/persona-memory");
    const loaded = await reloaded.getPersonaMemoryAsync("persona-a");
    expect(loaded.entries.map((entry) => entry.summary)).toEqual(["第1章：去日本旅行"]);
  });

  it("persists to the runtime json file when the node browser shim provides localStorage", async () => {
    await import("@/runtime/node/browser-shim");
    const memory = await import("@/lib/persona-memory");

    await memory.addSummariesToMemoryAsync("persona-shim", ["發布後要落盤"]);

    const file = path.join(runtimeRoot, "persona_memory.json");
    const persisted = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect((globalThis as any).localStorage.__nodeShim).toBe(true);
    expect(persisted["persona-shim"][0].summary).toBe("發布後要落盤");
  });

  it("keeps using real browser localStorage when it is not the node shim", async () => {
    const store = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
        clear: () => store.clear(),
      },
    };
    const memory = await import("@/lib/persona-memory");

    memory.addSummariesToMemory("persona-browser", ["浏览器记忆"]);

    expect(store.has("persona_memory_persona-browser")).toBe(true);
    expect(fs.existsSync(path.join(runtimeRoot, "persona_memory.json"))).toBe(false);
  });

  it("deletes only the target persona from the runtime json file after a cold start", async () => {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, "persona_memory.json"),
      JSON.stringify({
        "persona-a": [{
          id: "a-1",
          date: "2026-05-01T00:00:00.000Z",
          summary: "A 人設記憶",
        }],
        "persona-b": [{
          id: "b-1",
          date: "2026-05-02T00:00:00.000Z",
          summary: "B 人設記憶",
        }],
      }),
      "utf-8",
    );

    const memory = await import("@/lib/persona-memory");
    await memory.deletePersonaMemoryAsync("persona-a");

    const persisted = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "persona_memory.json"), "utf-8"));
    expect(persisted["persona-a"]).toBeUndefined();
    expect(persisted["persona-b"][0].summary).toBe("B 人設記憶");
  });
});
