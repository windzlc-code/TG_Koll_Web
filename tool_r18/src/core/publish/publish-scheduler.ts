import type { PublishTask } from "@/runtime/node/publish-queue-repository";
import type { NodePublishQueueRepository as PublishQueueRepository } from "@/runtime/node/publish-queue-repository";

const POLL_INTERVAL_MS = 10_000;
const STUCK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;
const JITTER_MS = 2_000;
const MAX_CONCURRENT_PUBLISH_TASKS = 3;

export type PublishTaskRunResult =
  | { status: "done" }
  | ({
      status: "failed";
      error: string;
    } & PublishTaskFailureEvidence)
  | ({
      status: "paused";
      pauseType: string;
      durationMs?: number;
      error?: string;
    } & PublishTaskFailureEvidence);

export interface PublishTaskFailureEvidence {
  failureStep?: string;
  screenshotUrl?: string;
  samplePath?: string;
  manualInterventionRequired?: boolean;
}

export type PublishTaskRunner = (task: PublishTask) => Promise<PublishTaskRunResult>;

export interface SchedulerHooks {
  onTaskStatusChange?: (taskId: string, status: PublishTask["status"], extra?: Record<string, unknown>) => void;
}

export interface PublishQueueRecoverySummary {
  interrupted: number;
  expiredPaused: number;
  requeued: number;
  failed: number;
  postPublishPaused: number;
  clearedLocks: number;
}

const POST_PUBLISH_VERIFICATION_MARKERS = [
  "发布动作已执行",
  "發布動作已執行",
  "发布按钮已点击",
  "發布按鈕已點選",
  "已执行发布",
  "已執行發布",
  "已点击发布",
  "已點選發布",
  "待人工确认",
  "待人工確認",
  "post_publish_verification",
];

function hasPostPublishVerificationMarker(value?: string | null): boolean {
  if (!value) return false;
  return POST_PUBLISH_VERIFICATION_MARKERS.some((marker) => value.includes(marker));
}

function backoffMs(attempts: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, attempts) + Math.floor(Math.random() * JITTER_MS);
}

export function recoverInterruptedPublishQueue(repo: PublishQueueRepository): PublishQueueRecoverySummary {
  const now = new Date().toISOString();
  const interrupted = repo.listTasks({ status: "publishing", limit: 500 });
  let requeued = 0;
  let failed = 0;
  let postPublishPaused = 0;

  for (const task of interrupted) {
    repo.releasePadLock(task.pad_code, task.id);
    if (hasPostPublishVerificationMarker(task.last_error)) {
      repo.updateTaskStatus(task.id, "paused", {
        pause_type: "post_publish_verification",
        last_error: "daemon 重启恢复：发布动作已执行但结果校验中断，已停止自动重试以避免重复发布",
      });
      postPublishPaused += 1;
      continue;
    }
    if (task.attempts >= MAX_ATTEMPTS) {
      repo.updateTaskStatus(task.id, "failed", {
        last_error: "daemon 重启恢复：任务上次中断且已达到最大尝试次数",
        finished_at: now,
      });
      failed += 1;
      continue;
    }
    repo.updateTaskStatus(task.id, "pending", {
      last_error: "daemon 重启恢复：上次发布中断，已重新加入待发布队列",
      scheduled_at: now,
    });
    requeued += 1;
  }

  const expiredPaused = repo.getExpiredPausedTasks();
  for (const task of expiredPaused) {
    repo.releasePadLock(task.pad_code, task.id);
    if (task.attempts >= MAX_ATTEMPTS) {
      repo.updateTaskStatus(task.id, "failed", {
        last_error: "daemon 重启恢复：暂停等待已过期且达到最大尝试次数",
        finished_at: now,
      });
      failed += 1;
      continue;
    }
    repo.updateTaskStatus(task.id, "pending", {
      last_error: "daemon 重启恢复：暂停等待已过期，已重新加入待发布队列",
      scheduled_at: now,
    });
    requeued += 1;
  }

  const clearedLocks = repo.releaseAllPadLocks();
  return {
    interrupted: interrupted.length,
    expiredPaused: expiredPaused.length,
    requeued,
    failed,
    postPublishPaused,
    clearedLocks,
  };
}

export class PublishSchedulerService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private activeTaskIds = new Set<string>();
  private activePadCodes = new Set<string>();
  private activeRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: PublishQueueRepository,
    private readonly runner: PublishTaskRunner,
    private readonly hooks: SchedulerHooks = {},
  ) {}

  async pollOnce(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const stuck = this.repo.getStuckPublishingTasks(STUCK_TIMEOUT_MS);
      for (const task of stuck) {
        this.repo.releasePadLock(task.pad_code, task.id);
        this.activeTaskIds.delete(task.id);
        this.activePadCodes.delete(task.pad_code);
        this.repo.updateTaskStatus(task.id, "failed", {
          last_error: "任務超時（>15 分鐘）",
          finished_at: new Date().toISOString(),
        });
        this.hooks.onTaskStatusChange?.(task.id, "failed", { reason: "timeout" });
      }

      const expired = this.repo.getExpiredPausedTasks();
      for (const task of expired) {
        this.repo.updateTaskStatus(task.id, "failed", {
          last_error: "暫停等待超時",
          finished_at: new Date().toISOString(),
        });
        this.hooks.onTaskStatusChange?.(task.id, "failed", { reason: "pause_timeout" });
      }

      const due = this.repo.getDuePendingTasks(50);
      const selectedPads = new Set<string>();
      let availableSlots = Math.max(0, MAX_CONCURRENT_PUBLISH_TASKS - this.activeTaskIds.size);
      for (const task of due) {
        if (availableSlots <= 0) break;
        if (selectedPads.has(task.pad_code)) continue;
        if (this.activePadCodes.has(task.pad_code)) continue;
        if (this.repo.isPadLocked(task.pad_code)) continue;
        if (!this.repo.acquirePadLock(task.pad_code, task.id)) continue;
        selectedPads.add(task.pad_code);

        this.repo.updateTaskStatus(task.id, "publishing", {
          started_at: new Date().toISOString(),
          attempts: task.attempts + 1,
        });
        this.hooks.onTaskStatusChange?.(task.id, "publishing");

        const latestTask = this.repo.getTask(task.id) || { ...task, attempts: task.attempts + 1, status: "publishing" } as PublishTask;
        this.startTask(latestTask);
        availableSlots -= 1;
      }
    } finally {
      this.isPolling = false;
    }
  }

  start(): void {
    this.stop();
    this.intervalId = setInterval(() => {
      this.pollOnce().catch((error) => {
        console.error("[PublishSchedulerService] pollOnce error:", error);
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeRuns.size > 0) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for scheduler idle");
      }
      await Promise.race([
        Promise.allSettled(Array.from(this.activeRuns.values())),
        new Promise((resolve) => setTimeout(resolve, 25)),
      ]);
    }
  }

  private startTask(task: PublishTask): void {
    this.activeTaskIds.add(task.id);
    this.activePadCodes.add(task.pad_code);
    const run = (async () => {
      try {
        const result = await this.runner(task);
        await this.completeTask(task, result);
      } catch (error: any) {
        await this.completeTask(task, {
          status: "failed",
          error: error?.message || String(error),
        });
      } finally {
        this.activeTaskIds.delete(task.id);
        this.activePadCodes.delete(task.pad_code);
        this.activeRuns.delete(task.id);
        void this.pollOnce().catch((error) => {
          console.error("[PublishSchedulerService] refill poll error:", error);
        });
      }
    })();
    this.activeRuns.set(task.id, run);
  }

  private async completeTask(task: PublishTask, result: PublishTaskRunResult): Promise<void> {
    const current = this.repo.getTask(task.id);
    if (current && current.status !== "publishing") {
      this.repo.releasePadLock(task.pad_code, task.id);
      return;
    }
    await this.handleRunResult(task, result);
  }

  private async handleRunResult(task: PublishTask, result: PublishTaskRunResult): Promise<void> {
    this.repo.releasePadLock(task.pad_code, task.id);

    if (result.status === "done") {
      this.repo.updateTaskStatus(task.id, "done", { finished_at: new Date().toISOString() });
      this.hooks.onTaskStatusChange?.(task.id, "done");
      return;
    }

    if (result.status === "paused") {
      const expiresAt = result.durationMs && result.durationMs > 0
        ? new Date(Date.now() + result.durationMs).toISOString()
        : undefined;
      const update: {
        pause_type: string;
        pause_expires_at?: string;
        last_error?: string;
        failure_step?: string;
        failure_screenshot_url?: string;
        failure_sample_path?: string;
        manual_intervention_required?: number;
      } = {
        pause_type: result.pauseType,
      };
      if (expiresAt) update.pause_expires_at = expiresAt;
      if (result.error) update.last_error = result.error;
      if (result.failureStep) update.failure_step = result.failureStep;
      if (result.screenshotUrl) update.failure_screenshot_url = result.screenshotUrl;
      if (result.samplePath) update.failure_sample_path = result.samplePath;
      if (result.manualInterventionRequired !== undefined) {
        update.manual_intervention_required = result.manualInterventionRequired ? 1 : 0;
      }
      this.repo.updateTaskStatus(task.id, "paused", update);
      this.hooks.onTaskStatusChange?.(task.id, "paused", { pauseType: result.pauseType, expiresAt, error: result.error, failureStep: result.failureStep, screenshotUrl: result.screenshotUrl, samplePath: result.samplePath, manualInterventionRequired: result.manualInterventionRequired });
      return;
    }

    if (task.attempts >= MAX_ATTEMPTS) {
      this.repo.updateTaskStatus(task.id, "failed", {
        last_error: result.error,
        failure_step: result.failureStep,
        failure_screenshot_url: result.screenshotUrl,
        failure_sample_path: result.samplePath,
        manual_intervention_required: result.manualInterventionRequired === false ? 0 : 1,
        finished_at: new Date().toISOString(),
      });
      this.hooks.onTaskStatusChange?.(task.id, "failed", { error: result.error, failureStep: result.failureStep, screenshotUrl: result.screenshotUrl, samplePath: result.samplePath, manualInterventionRequired: result.manualInterventionRequired === false ? false : true });
      return;
    }

    const delay = backoffMs(task.attempts);
    const retryAt = new Date(Date.now() + delay).toISOString();
    this.repo.updateTaskStatus(task.id, "pending", {
      last_error: result.error,
      failure_step: result.failureStep,
      failure_screenshot_url: result.screenshotUrl,
      failure_sample_path: result.samplePath,
      manual_intervention_required: result.manualInterventionRequired === false ? 0 : 1,
      scheduled_at: retryAt,
    });
    this.hooks.onTaskStatusChange?.(task.id, "pending", { error: result.error, retryAt, failureStep: result.failureStep, screenshotUrl: result.screenshotUrl, samplePath: result.samplePath, manualInterventionRequired: result.manualInterventionRequired === false ? false : true });
  }
}
