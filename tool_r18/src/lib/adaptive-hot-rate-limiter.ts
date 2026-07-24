export interface AdaptiveHotRateLimiterOptions {
  maxConcurrency?: number;
  initialConcurrency?: number;
  minConcurrency?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  concurrencyDecreaseFactor?: number;
  recoverySuccessThreshold?: number;
  random?: () => number;
  now?: () => number;
}

export interface AdaptiveHotRateLimitRunOptions {
  signal?: AbortSignal;
  /**
   * Covers queue wait and execution time. The task receives an aborted signal
   * when the deadline is reached.
   */
  timeoutMs?: number;
}

export interface AdaptiveHotRateLimitContext {
  signal: AbortSignal;
  /**
   * Use this when an upstream SDK consumes the response internally. Standard
   * Response-like 429 results and errors are detected automatically.
   */
  reportRateLimit: (retryAfterMs?: number) => void;
}

export interface AdaptiveHotRateLimitSnapshot {
  key: string;
  currentConcurrency: number;
  maxConcurrency: number;
  minConcurrency: number;
  inFlight: number;
  queued: number;
  consecutiveSuccesses: number;
  rateLimitStreak: number;
  blockedUntil: number;
  retryInMs: number;
}

export class AdaptiveHotRateLimitAbortError extends Error {
  constructor(message = "Adaptive rate-limited task was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class AdaptiveHotRateLimitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Adaptive rate-limited task timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

interface NormalizedOptions {
  maxConcurrency: number;
  initialConcurrency: number;
  minConcurrency: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  concurrencyDecreaseFactor: number;
  recoverySuccessThreshold: number;
  random: () => number;
  now: () => number;
}

interface PendingTask<T> {
  task: (context: AdaptiveHotRateLimitContext) => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  controller: AbortController;
  externalSignal?: AbortSignal;
  externalAbortListener?: () => void;
  timeoutId?: ReturnType<typeof setTimeout>;
  timeoutMs?: number;
  executionStarted: boolean;
  callerSettled: boolean;
  rateLimited: boolean;
}

interface UpstreamState {
  key: string;
  options: NormalizedOptions;
  currentConcurrency: number;
  inFlight: number;
  consecutiveSuccesses: number;
  rateLimitStreak: number;
  blockedUntil: number;
  queue: Array<PendingTask<unknown>>;
  tasks: Set<PendingTask<unknown>>;
  wakeTimer?: ReturnType<typeof setTimeout>;
  resetting: boolean;
}

interface RateLimitInfo {
  retryAfterMs?: number;
}

const DEFAULT_OPTIONS: Required<Omit<AdaptiveHotRateLimiterOptions, "random" | "now">> = {
  maxConcurrency: 8,
  initialConcurrency: 8,
  minConcurrency: 1,
  baseBackoffMs: 500,
  maxBackoffMs: 60_000,
  jitterRatio: 0.25,
  concurrencyDecreaseFactor: 0.5,
  recoverySuccessThreshold: 8,
};

// Every limiter instance in this module coordinates through the same process-local registry.
const sharedUpstreamStates = new Map<string, UpstreamState>();

function clampInteger(value: number | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function normalizeOptions(options: AdaptiveHotRateLimiterOptions): NormalizedOptions {
  const maxConcurrency = clampInteger(options.maxConcurrency, DEFAULT_OPTIONS.maxConcurrency, 1);
  const minConcurrency = clampInteger(options.minConcurrency, DEFAULT_OPTIONS.minConcurrency, 1, maxConcurrency);
  const initialConcurrency = clampInteger(
    options.initialConcurrency,
    maxConcurrency,
    minConcurrency,
    maxConcurrency,
  );
  const baseBackoffMs = clampInteger(options.baseBackoffMs, DEFAULT_OPTIONS.baseBackoffMs, 0);
  const maxBackoffMs = clampInteger(
    options.maxBackoffMs,
    DEFAULT_OPTIONS.maxBackoffMs,
    baseBackoffMs,
  );
  const jitterRatio = Number.isFinite(options.jitterRatio)
    ? Math.max(0, options.jitterRatio as number)
    : DEFAULT_OPTIONS.jitterRatio;
  const decreaseFactor = Number.isFinite(options.concurrencyDecreaseFactor)
    ? options.concurrencyDecreaseFactor as number
    : DEFAULT_OPTIONS.concurrencyDecreaseFactor;

  return {
    maxConcurrency,
    minConcurrency,
    initialConcurrency,
    baseBackoffMs,
    maxBackoffMs,
    jitterRatio,
    concurrencyDecreaseFactor: decreaseFactor > 0 && decreaseFactor < 1
      ? decreaseFactor
      : DEFAULT_OPTIONS.concurrencyDecreaseFactor,
    recoverySuccessThreshold: clampInteger(
      options.recoverySuccessThreshold,
      DEFAULT_OPTIONS.recoverySuccessThreshold,
      1,
    ),
    random: options.random || Math.random,
    now: options.now || Date.now,
  };
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;

  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = get.call(headers, name);
    return value == null ? null : String(value);
  }

  const record = headers as Record<string, unknown>;
  const matchedKey = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = matchedKey ? record[matchedKey] : undefined;
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  return value == null ? null : String(value);
}

/**
 * Parses the HTTP Retry-After format (delta seconds or an HTTP date).
 */
export function parseRetryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - now);
}

function extractStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const directStatus = Number((value as { status?: unknown }).status);
  if (Number.isFinite(directStatus)) return directStatus;
  const statusCode = Number((value as { statusCode?: unknown }).statusCode);
  if (Number.isFinite(statusCode)) return statusCode;
  return undefined;
}

function extractRateLimitInfo(value: unknown, now: number): RateLimitInfo | undefined {
  if (!value || typeof value !== "object") return undefined;

  const directStatus = extractStatus(value);
  const response = (value as { response?: unknown }).response;
  const responseStatus = extractStatus(response);
  if (directStatus !== 429 && responseStatus !== 429) return undefined;

  const headers = directStatus === 429
    ? (value as { headers?: unknown }).headers
    : (response as { headers?: unknown } | undefined)?.headers;
  return {
    retryAfterMs: parseRetryAfterMs(readHeader(headers, "retry-after"), now),
  };
}

function isSuccessfulOutcome(value: unknown): boolean {
  const status = extractStatus(value);
  return status === undefined || (status >= 200 && status < 400);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  return new AdaptiveHotRateLimitAbortError();
}

export class AdaptiveHotRateLimiter {
  private readonly options: NormalizedOptions;

  constructor(options: AdaptiveHotRateLimiterOptions = {}) {
    this.options = normalizeOptions(options);
  }

  run<T>(
    upstreamKey: string,
    task: (context: AdaptiveHotRateLimitContext) => Promise<T> | T,
    options: AdaptiveHotRateLimitRunOptions = {},
  ): Promise<T> {
    const key = upstreamKey.trim();
    if (!key) return Promise.reject(new TypeError("upstreamKey must not be empty"));
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));

    const state = this.getOrCreateState(key);
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask<T> = {
        task,
        resolve,
        reject,
        controller: new AbortController(),
        externalSignal: options.signal,
        timeoutMs: options.timeoutMs,
        executionStarted: false,
        callerSettled: false,
        rateLimited: false,
      };

      if (options.signal) {
        pending.externalAbortListener = () => {
          this.cancelTask(state, pending, abortReason(options.signal as AbortSignal));
        };
        options.signal.addEventListener("abort", pending.externalAbortListener, { once: true });
      }

      if (options.timeoutMs !== undefined) {
        const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
        pending.timeoutMs = timeoutMs;
        pending.timeoutId = setTimeout(() => {
          this.cancelTask(state, pending, new AdaptiveHotRateLimitTimeoutError(timeoutMs));
        }, timeoutMs);
      }

      state.queue.push(pending as PendingTask<unknown>);
      state.tasks.add(pending as PendingTask<unknown>);
      this.drain(state);
    });
  }

  getSnapshot(upstreamKey: string): AdaptiveHotRateLimitSnapshot | undefined {
    const state = sharedUpstreamStates.get(upstreamKey.trim());
    if (!state) return undefined;
    const now = state.options.now();
    return {
      key: state.key,
      currentConcurrency: state.currentConcurrency,
      maxConcurrency: state.options.maxConcurrency,
      minConcurrency: state.options.minConcurrency,
      inFlight: state.inFlight,
      queued: state.queue.filter((task) => !task.callerSettled).length,
      consecutiveSuccesses: state.consecutiveSuccesses,
      rateLimitStreak: state.rateLimitStreak,
      blockedUntil: state.blockedUntil,
      retryInMs: Math.max(0, state.blockedUntil - now),
    };
  }

  reset(upstreamKey?: string): void {
    const states = upstreamKey === undefined
      ? [...sharedUpstreamStates.values()]
      : [sharedUpstreamStates.get(upstreamKey.trim())].filter((state): state is UpstreamState => Boolean(state));

    for (const state of states) {
      state.resetting = true;
      if (state.wakeTimer) clearTimeout(state.wakeTimer);
      state.wakeTimer = undefined;
      const reason = new AdaptiveHotRateLimitAbortError("Adaptive rate limiter state was reset");
      for (const task of [...state.tasks]) {
        this.cancelTask(state, task, reason);
      }
      state.queue = [];
      sharedUpstreamStates.delete(state.key);
    }
  }

  private getOrCreateState(key: string): UpstreamState {
    const existing = sharedUpstreamStates.get(key);
    if (existing) return existing;

    const state: UpstreamState = {
      key,
      options: this.options,
      currentConcurrency: this.options.initialConcurrency,
      inFlight: 0,
      consecutiveSuccesses: 0,
      rateLimitStreak: 0,
      blockedUntil: 0,
      queue: [],
      tasks: new Set(),
      resetting: false,
    };
    sharedUpstreamStates.set(key, state);
    return state;
  }

  private drain(state: UpstreamState): void {
    if (state.resetting) return;
    const now = state.options.now();
    if (state.blockedUntil > now) {
      this.scheduleWake(state);
      return;
    }

    if (state.wakeTimer) clearTimeout(state.wakeTimer);
    state.wakeTimer = undefined;
    while (state.inFlight < state.currentConcurrency && state.queue.length > 0) {
      const pending = state.queue.shift() as PendingTask<unknown>;
      if (pending.callerSettled) continue;
      this.startTask(state, pending);
    }
  }

  private scheduleWake(state: UpstreamState): void {
    if (state.wakeTimer || state.queue.length === 0 || state.resetting) return;
    const waitMs = Math.max(0, state.blockedUntil - state.options.now());
    state.wakeTimer = setTimeout(() => {
      state.wakeTimer = undefined;
      this.drain(state);
    }, waitMs);
  }

  private startTask(state: UpstreamState, pending: PendingTask<unknown>): void {
    pending.executionStarted = true;
    state.inFlight += 1;

    const context: AdaptiveHotRateLimitContext = {
      signal: pending.controller.signal,
      reportRateLimit: (retryAfterMs) => {
        if (pending.rateLimited) return;
        pending.rateLimited = true;
        this.recordRateLimit(state, retryAfterMs);
      },
    };

    Promise.resolve()
      .then(() => pending.task(context))
      .then(
        (result) => {
          if (!pending.rateLimited) {
            const rateLimit = extractRateLimitInfo(result, state.options.now());
            if (rateLimit) {
              pending.rateLimited = true;
              this.recordRateLimit(state, rateLimit.retryAfterMs);
            } else if (!pending.controller.signal.aborted) {
              if (isSuccessfulOutcome(result)) this.recordSuccess(state);
              else this.recordFailure(state);
            }
          }
          this.resolveCaller(pending, result);
        },
        (error) => {
          if (!pending.rateLimited) {
            const rateLimit = extractRateLimitInfo(error, state.options.now());
            if (rateLimit) {
              pending.rateLimited = true;
              this.recordRateLimit(state, rateLimit.retryAfterMs);
            } else if (!pending.controller.signal.aborted) {
              this.recordFailure(state);
            }
          }
          this.rejectCaller(pending, error);
        },
      )
      .finally(() => {
        state.inFlight = Math.max(0, state.inFlight - 1);
        state.tasks.delete(pending);
        this.cleanupCancellation(pending);
        this.drain(state);
      });
  }

  private recordRateLimit(state: UpstreamState, retryAfterMs?: number): void {
    const exponentialDelay = Math.min(
      state.options.maxBackoffMs,
      state.options.baseBackoffMs * (2 ** state.rateLimitStreak),
    );
    const jitter = Math.floor(
      exponentialDelay * state.options.jitterRatio * Math.max(0, state.options.random()),
    );
    const delayMs = Math.max(exponentialDelay, Math.max(0, retryAfterMs || 0)) + jitter;
    const reducedConcurrency = Math.floor(
      state.currentConcurrency * state.options.concurrencyDecreaseFactor,
    );

    state.currentConcurrency = Math.max(state.options.minConcurrency, reducedConcurrency);
    state.consecutiveSuccesses = 0;
    state.rateLimitStreak += 1;
    state.blockedUntil = Math.max(state.blockedUntil, state.options.now() + delayMs);
    if (state.wakeTimer) clearTimeout(state.wakeTimer);
    state.wakeTimer = undefined;
    this.scheduleWake(state);
  }

  private recordSuccess(state: UpstreamState): void {
    if (state.options.now() < state.blockedUntil) return;
    if (state.currentConcurrency >= state.options.maxConcurrency) {
      state.consecutiveSuccesses = 0;
      state.rateLimitStreak = 0;
      return;
    }

    state.consecutiveSuccesses += 1;
    if (state.consecutiveSuccesses < state.options.recoverySuccessThreshold) return;

    state.currentConcurrency = Math.min(
      state.options.maxConcurrency,
      state.currentConcurrency + 1,
    );
    state.consecutiveSuccesses = 0;
    state.rateLimitStreak = 0;
    this.drain(state);
  }

  private recordFailure(state: UpstreamState): void {
    state.consecutiveSuccesses = 0;
  }

  private cancelTask(state: UpstreamState, pending: PendingTask<unknown>, reason: unknown): void {
    if (pending.callerSettled) return;
    if (!pending.controller.signal.aborted) pending.controller.abort(reason);
    this.rejectCaller(pending, reason);

    if (!pending.executionStarted) {
      const index = state.queue.indexOf(pending);
      if (index >= 0) state.queue.splice(index, 1);
      state.tasks.delete(pending);
      this.drain(state);
    }
  }

  private resolveCaller<T>(pending: PendingTask<T>, value: T): void {
    if (pending.callerSettled) return;
    pending.callerSettled = true;
    this.cleanupCancellation(pending);
    pending.resolve(value);
  }

  private rejectCaller(pending: PendingTask<unknown>, reason: unknown): void {
    if (pending.callerSettled) return;
    pending.callerSettled = true;
    this.cleanupCancellation(pending);
    pending.reject(reason);
  }

  private cleanupCancellation(pending: PendingTask<unknown>): void {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    pending.timeoutId = undefined;
    if (pending.externalSignal && pending.externalAbortListener) {
      pending.externalSignal.removeEventListener("abort", pending.externalAbortListener);
    }
    pending.externalAbortListener = undefined;
  }
}

export const adaptiveHotRateLimiter = new AdaptiveHotRateLimiter();

export function runWithAdaptiveHotRateLimit<T>(
  upstreamKey: string,
  task: (context: AdaptiveHotRateLimitContext) => Promise<T> | T,
  options?: AdaptiveHotRateLimitRunOptions,
): Promise<T> {
  return adaptiveHotRateLimiter.run(upstreamKey, task, options);
}

