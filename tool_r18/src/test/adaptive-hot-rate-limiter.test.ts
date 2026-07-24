import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdaptiveHotRateLimiter,
  parseRetryAfterMs,
} from "@/lib/adaptive-hot-rate-limiter";

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  new AdaptiveHotRateLimiter().reset();
  vi.useRealTimers();
});

describe("adaptive hot rate limiter", () => {
  it("shares concurrency by upstream key across limiter instances", async () => {
    const firstLimiter = new AdaptiveHotRateLimiter({
      maxConcurrency: 2,
      recoverySuccessThreshold: 2,
    });
    const secondLimiter = new AdaptiveHotRateLimiter({
      maxConcurrency: 2,
      recoverySuccessThreshold: 2,
    });
    const releases: Array<() => void> = [];
    let running = 0;
    let peakRunning = 0;
    let sharedKeyStarts = 0;

    const task = () => {
      sharedKeyStarts += 1;
      running += 1;
      peakRunning = Math.max(peakRunning, running);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });
    };

    const first = firstLimiter.run("threads:shared-api-key", task);
    const second = secondLimiter.run("threads:shared-api-key", task);
    const queued = firstLimiter.run("threads:shared-api-key", task);
    const independent = secondLimiter.run("instagram:other-api-key", async () => "ok");

    await flushMicrotasks();

    expect(sharedKeyStarts).toBe(2);
    expect(peakRunning).toBe(2);
    expect(firstLimiter.getSnapshot("threads:shared-api-key")).toMatchObject({
      currentConcurrency: 2,
      inFlight: 2,
      queued: 1,
    });
    await expect(independent).resolves.toBe("ok");

    releases.shift()?.();
    await flushMicrotasks();
    expect(sharedKeyStarts).toBe(3);
    expect(peakRunning).toBe(2);

    for (const release of releases.splice(0)) release();
    await Promise.all([first, second, queued]);
  });

  it("honors Retry-After, adds jitter, and lowers concurrency after a 429 response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const limiter = new AdaptiveHotRateLimiter({
      maxConcurrency: 4,
      baseBackoffMs: 100,
      maxBackoffMs: 10_000,
      jitterRatio: 0.5,
      concurrencyDecreaseFactor: 0.5,
      recoverySuccessThreshold: 10,
      random: () => 1,
    });

    await limiter.run("threads:retry-after", async () => ({
      status: 429,
      headers: new Headers({ "Retry-After": "2" }),
    }));

    expect(limiter.getSnapshot("threads:retry-after")).toMatchObject({
      currentConcurrency: 2,
      rateLimitStreak: 1,
      retryInMs: 2050,
    });
  });

  it("uses exponential backoff with jitter for repeated rate limits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const limiter = new AdaptiveHotRateLimiter({
      maxConcurrency: 4,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterRatio: 0.5,
      concurrencyDecreaseFactor: 0.5,
      recoverySuccessThreshold: 10,
      random: () => 1,
    });

    await limiter.run("threads:exponential", async () => ({ status: 429 }));
    expect(limiter.getSnapshot("threads:exponential")?.retryInMs).toBe(150);

    let secondStarted = false;
    const second = limiter.run("threads:exponential", async () => {
      secondStarted = true;
      return { status: 429 };
    });
    await flushMicrotasks();
    expect(secondStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(149);
    expect(secondStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;

    expect(limiter.getSnapshot("threads:exponential")).toMatchObject({
      currentConcurrency: 1,
      rateLimitStreak: 2,
      retryInMs: 300,
    });
  });

  it("recovers concurrency one slot at a time after consecutive successes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const limiter = new AdaptiveHotRateLimiter({
      maxConcurrency: 4,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterRatio: 0,
      concurrencyDecreaseFactor: 0.5,
      recoverySuccessThreshold: 2,
    });
    const key = "threads:recovery";

    await limiter.run(key, async () => ({ status: 429 }));
    expect(limiter.getSnapshot(key)?.currentConcurrency).toBe(2);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([
      limiter.run(key, async () => ({ status: 200 })),
      limiter.run(key, async () => ({ status: 200 })),
    ]);
    expect(limiter.getSnapshot(key)).toMatchObject({
      currentConcurrency: 3,
      rateLimitStreak: 0,
    });

    await Promise.all([
      limiter.run(key, async () => "ok"),
      limiter.run(key, async () => "ok"),
    ]);
    expect(limiter.getSnapshot(key)?.currentConcurrency).toBe(4);
  });

  it("removes an aborted queued task without consuming a concurrency slot", async () => {
    const limiter = new AdaptiveHotRateLimiter({ maxConcurrency: 1 });
    let releaseFirst: (() => void) | undefined;
    let queuedTaskStarted = false;
    const first = limiter.run("threads:abort", () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const controller = new AbortController();
    const queued = limiter.run("threads:abort", async () => {
      queuedTaskStarted = true;
    }, { signal: controller.signal });

    await flushMicrotasks();
    expect(limiter.getSnapshot("threads:abort")).toMatchObject({
      inFlight: 1,
      queued: 1,
    });

    const rejection = expect(queued).rejects.toHaveProperty("name", "AbortError");
    controller.abort();
    await rejection;

    expect(queuedTaskStarted).toBe(false);
    expect(limiter.getSnapshot("threads:abort")).toMatchObject({
      inFlight: 1,
      queued: 0,
    });

    releaseFirst?.();
    await first;
  });

  it("aborts an executing task when its total timeout expires", async () => {
    vi.useFakeTimers();
    const limiter = new AdaptiveHotRateLimiter({ maxConcurrency: 1 });
    let taskSignal: AbortSignal | undefined;
    const timedOut = limiter.run("threads:timeout", ({ signal }) => {
      taskSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }, { timeoutMs: 250 });

    await flushMicrotasks();
    const rejection = expect(timedOut).rejects.toHaveProperty("name", "TimeoutError");
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    await flushMicrotasks();

    expect(taskSignal?.aborted).toBe(true);
    expect(limiter.getSnapshot("threads:timeout")).toMatchObject({
      inFlight: 0,
      queued: 0,
    });
  });

  it("parses both Retry-After header formats", () => {
    const now = Date.parse("2026-07-24T00:00:00.000Z");
    expect(parseRetryAfterMs("1.5", now)).toBe(1500);
    expect(parseRetryAfterMs("Fri, 24 Jul 2026 00:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfterMs("not-a-date", now)).toBeUndefined();
  });
});
