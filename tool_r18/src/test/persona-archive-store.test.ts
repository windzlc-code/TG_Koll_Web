import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updatePersonaArchivePlatformHotMetrics, updatePersonaArchiveThreadsHotMetrics } from "@/runtime/node/persona-archive-store";

const tempDirs: string[] = [];

function useArchiveStore(items: any[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-archive-store-"));
  tempDirs.push(dir);
  process.env.TOOL_R18_RUNTIME_DIR = dir;
  fs.writeFileSync(path.join(dir, "persona_archives.json"), JSON.stringify(items, null, 2), "utf-8");
  return dir;
}

function readArchives(dir: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, "persona_archives.json"), "utf-8"));
}

afterEach(() => {
  delete process.env.TOOL_R18_RUNTIME_DIR;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("persona archive hot metric store", () => {
  it("stores Instagram metrics without mutating the legacy Threads binding", () => {
    const dir = useArchiveStore([{
      id: "persona-1",
      name: "理发师",
      content: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      setup: { accountManagement: { threads: { handle: "current.threads" } } },
      posts: [],
    }]);

    const result = updatePersonaArchivePlatformHotMetrics({
      archiveId: "persona-1",
      metricKey: "instagram:demo.user",
      metric: { platform: "instagram", accountId: "ig-1", username: "demo.user", followers: 1200 },
      updatedAt: "2026-08-08T08:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const [archive] = readArchives(dir);
    expect(archive.setup.accountManagement.threads.handle).toBe("current.threads");
    expect(archive.setup.hotMetrics["instagram:demo.user"].accountId).toBe("ig-1");
  });

  it("bootstraps the legacy Threads binding when only the account pool binding is known", () => {
    const dir = useArchiveStore([{
      id: "persona-1",
      name: "理发师",
      content: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      setup: {},
      posts: [],
    }]);

    const result = updatePersonaArchiveThreadsHotMetrics({
      archiveId: "persona-1",
      expectedHandle: "le.huuuczxsn.196960",
      metricKey: "threads:le.huuuczxsn.196960",
      metric: { username: "le.huuuczxsn.196960", complete: true, postMetrics: [{ code: "Db1", viewCount: 12 }] },
      authProfileKey: "social_account_1",
      updatedAt: "2026-08-07T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const [archive] = readArchives(dir);
    expect(archive.setup.accountManagement.threads.handle).toBe("le.huuuczxsn.196960");
    expect(archive.setup.hotMetrics["threads:le.huuuczxsn.196960"].postMetrics).toHaveLength(1);
  });

  it("rejects writes when an existing legacy Threads binding changed", () => {
    const dir = useArchiveStore([{
      id: "persona-1",
      name: "理发师",
      content: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      setup: {
        accountManagement: {
          threads: { handle: "old.account" },
        },
      },
      posts: [],
    }]);

    const result = updatePersonaArchiveThreadsHotMetrics({
      archiveId: "persona-1",
      expectedHandle: "le.huuuczxsn.196960",
      metricKey: "threads:le.huuuczxsn.196960",
      metric: { username: "le.huuuczxsn.196960", complete: true, postMetrics: [{ code: "Db1", viewCount: 12 }] },
      updatedAt: "2026-08-07T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: false, reason: "threads_binding_changed" });
    const [archive] = readArchives(dir);
    expect(archive.setup.hotMetrics).toBeUndefined();
  });

  it("accepts a freshly verified account-pool binding and synchronizes the legacy handle", () => {
    const publishHistory = [{ id: "published-1", publishedAt: "2026-08-01T00:00:00.000Z" }];
    const dir = useArchiveStore([{
      id: "persona-1",
      name: "理发师",
      content: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      setup: { accountManagement: { threads: { handle: "old.account" } } },
      publishHistory,
      posts: [],
    }]);

    const result = updatePersonaArchiveThreadsHotMetrics({
      archiveId: "persona-1",
      expectedHandle: "current.account",
      metricKey: "threads:current.account",
      metric: { username: "current.account", complete: true, postMetrics: [{ code: "DbNow", viewCount: 4400 }] },
      replaceLegacyHandle: true,
      updatedAt: "2026-08-10T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const [archive] = readArchives(dir);
    expect(archive.setup.accountManagement.threads.handle).toBe("current.account");
    expect(archive.setup.hotMetrics["threads:current.account"].postMetrics[0].viewCount).toBe(4400);
    expect(archive.publishHistory).toEqual(publishHistory);
  });

  it("preserves historical Threads metrics while updating the current binding", () => {
    const historicalMetric = {
      username: "old.history.account",
      complete: true,
      postMetrics: [{ code: "DbOld", viewCount: 18 }],
    };
    const dir = useArchiveStore([{
      id: "persona-1",
      name: "理发师",
      content: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      setup: {
        accountManagement: {
          threads: { handle: "current.account" },
        },
        hotMetrics: {
          "threads:old.history.account": historicalMetric,
        },
      },
      posts: [],
    }]);

    const result = updatePersonaArchiveThreadsHotMetrics({
      archiveId: "persona-1",
      expectedHandle: "current.account",
      metricKey: "threads:current.account",
      metric: { username: "current.account", complete: true, postMetrics: [{ code: "DbNow", viewCount: 28 }] },
      updatedAt: "2026-08-10T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const [archive] = readArchives(dir);
    expect(archive.setup.accountManagement.threads.handle).toBe("current.account");
    expect(archive.setup.hotMetrics["threads:old.history.account"]).toEqual(historicalMetric);
    expect(archive.setup.hotMetrics["threads:current.account"].postMetrics[0].code).toBe("DbNow");
  });

  it("allows additional historical Threads handles without changing the current binding", () => {
    const dir = useArchiveStore([{
      id: "persona-1",
      name: "理发师",
      content: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      setup: {
        accountManagement: {
          threads: { handle: "current.account" },
        },
      },
      posts: [],
    }]);

    const result = updatePersonaArchiveThreadsHotMetrics({
      archiveId: "persona-1",
      expectedHandle: "old.history.account",
      metricKey: "threads:old.history.account",
      metric: { username: "old.history.account", complete: true, postMetrics: [{ code: "DbOld", viewCount: 18 }] },
      allowAdditionalHandle: true,
      updatedAt: "2026-08-07T10:00:00.000Z",
    });

    expect(result).toEqual({ ok: true });
    const [archive] = readArchives(dir);
    expect(archive.setup.accountManagement.threads.handle).toBe("current.account");
    expect(archive.setup.hotMetrics["threads:old.history.account"].postMetrics[0].code).toBe("DbOld");
  });
});
