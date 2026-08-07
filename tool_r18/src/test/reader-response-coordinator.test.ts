import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReaderResponseCoordinator,
  type ReaderResponseSnapshot,
} from "@/lib/reader-response-coordinator";

const tempDirs: string[] = [];

function response(body: string, status = 200): ReaderResponseSnapshot {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { "content-type": "text/markdown" },
    body,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reader response coordinator", () => {
  it("coalesces concurrent requests for the same Reader URL", async () => {
    const coordinator = createReaderResponseCoordinator();
    const pending = deferred<ReaderResponseSnapshot>();
    let loads = 0;
    const loader = () => {
      loads += 1;
      return pending.promise;
    };

    const requests = Array.from({ length: 10 }, () => coordinator.getOrLoad("same", loader));
    expect(loads).toBe(1);
    pending.resolve(response("shared"));

    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 10 }, () => response("shared")),
    );
  });

  it("reuses fresh responses across coordinator instances through the runtime cache", async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "reader-cache-"));
    tempDirs.push(storageDir);
    let now = 1_000;
    let loads = 0;
    const first = createReaderResponseCoordinator({ storageDir, now: () => now });
    await first.getOrLoad("persisted", async () => {
      loads += 1;
      return response("from-network");
    });

    now += 60_000;
    const second = createReaderResponseCoordinator({ storageDir, now: () => now });
    const cached = await second.getOrLoad("persisted", async () => {
      loads += 1;
      return response("unexpected");
    });

    expect(cached.body).toBe("from-network");
    expect(loads).toBe(1);
  });

  it("returns stale data immediately and refreshes it once in the background", async () => {
    let now = 0;
    const coordinator = createReaderResponseCoordinator({
      freshTtlMs: 100,
      staleTtlMs: 200,
      now: () => now,
    });
    await coordinator.getOrLoad("stale", async () => response("old"));
    now = 150;
    const pending = deferred<ReaderResponseSnapshot>();
    let refreshes = 0;
    const loader = () => {
      refreshes += 1;
      return pending.promise;
    };

    const first = await coordinator.getOrLoad("stale", loader);
    const second = await coordinator.getOrLoad("stale", loader);
    expect(first.body).toBe("old");
    expect(second.body).toBe("old");
    expect(refreshes).toBe(1);

    pending.resolve(response("new"));
    await pending.promise;
    await Promise.resolve();
    expect((await coordinator.getOrLoad("stale", loader)).body).toBe("new");
  });

  it("does not replace a stale response with a rate-limit response", async () => {
    let now = 0;
    const coordinator = createReaderResponseCoordinator({
      freshTtlMs: 100,
      staleTtlMs: 200,
      now: () => now,
    });
    const isCacheable = (value: ReaderResponseSnapshot) => value.ok && value.body.length > 0;
    await coordinator.getOrLoad("limited", async () => response("old"), { isCacheable });
    now = 150;

    const stale = await coordinator.getOrLoad(
      "limited",
      async () => response("too many requests", 429),
      { mode: "blocking-refresh", isCacheable },
    );

    expect(stale.body).toBe("old");
    expect(stale.status).toBe(200);
  });

  it("does not use an expired response when a refresh is rate limited", async () => {
    let now = 0;
    const coordinator = createReaderResponseCoordinator({
      freshTtlMs: 100,
      staleTtlMs: 200,
      now: () => now,
    });
    const isCacheable = (value: ReaderResponseSnapshot) => value.ok && value.body.length > 0;
    await coordinator.getOrLoad("expired", async () => response("old"), { isCacheable });
    now = 301;

    const limited = await coordinator.getOrLoad(
      "expired",
      async () => response("too many requests", 429),
      { mode: "blocking-refresh", isCacheable },
    );

    expect(limited.body).toBe("too many requests");
    expect(limited.status).toBe(429);
  });

  it("bypasses both cache reads and writes for forced detail requests", async () => {
    const coordinator = createReaderResponseCoordinator();
    let loads = 0;
    const load = async () => response(`value-${++loads}`);

    expect((await coordinator.getOrLoad("detail", load, { mode: "bypass" })).body).toBe("value-1");
    expect((await coordinator.getOrLoad("detail", load, { mode: "bypass" })).body).toBe("value-2");
    expect(loads).toBe(2);
  });
});
