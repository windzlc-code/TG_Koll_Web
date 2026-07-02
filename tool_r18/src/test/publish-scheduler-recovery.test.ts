import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublishSchedulerService, recoverInterruptedPublishQueue, type PublishTaskRunResult } from "@/core/publish/publish-scheduler";
import { createNodePublishQueueRepository } from "@/runtime/node/publish-queue-repository";

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-recovery-"));
  return path.join(dir, "publish_queue.db");
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("publish scheduler recovery", () => {
  it("requeues interrupted publishing tasks and releases stale pad locks", () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const task = repo.enqueueTask({
      pad_code: "PAD-1",
      platform: "threads",
      caption: "recover me",
    });

    expect(repo.acquirePadLock(task.pad_code, task.id)).toBe(true);
    repo.updateTaskStatus(task.id, "publishing", {
      attempts: 1,
      started_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const summary = recoverInterruptedPublishQueue(repo);
    const recovered = repo.getTask(task.id);

    expect(summary).toMatchObject({
      interrupted: 1,
      requeued: 1,
      failed: 0,
    });
    expect(recovered?.status).toBe("pending");
    expect(recovered?.last_error).toContain("daemon 重启恢复");
    expect(repo.isPadLocked(task.pad_code)).toBe(false);
  });

  it("fails interrupted tasks that already reached the max attempt count", () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const task = repo.enqueueTask({
      pad_code: "PAD-2",
      platform: "threads",
      caption: "already retried",
    });

    repo.updateTaskStatus(task.id, "publishing", {
      attempts: 3,
      started_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const summary = recoverInterruptedPublishQueue(repo);
    const recovered = repo.getTask(task.id);

    expect(summary).toMatchObject({
      interrupted: 1,
      requeued: 0,
      failed: 1,
    });
    expect(recovered?.status).toBe("failed");
    expect(recovered?.last_error).toContain("最大尝试次数");
  });

  it("pauses interrupted tasks after the publish action was already executed", () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const task = repo.enqueueTask({
      pad_code: "PAD-POST-PUBLISH",
      platform: "threads",
      caption: "do not duplicate",
    });

    expect(repo.acquirePadLock(task.pad_code, task.id)).toBe(true);
    repo.updateTaskStatus(task.id, "publishing", {
      attempts: 1,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_error: "发布动作已执行，等待结果校验；如 daemon 重启将暂停任务以避免重复发布",
    });

    const summary = recoverInterruptedPublishQueue(repo);
    const recovered = repo.getTask(task.id);

    expect(summary).toMatchObject({
      interrupted: 1,
      requeued: 0,
      failed: 0,
      postPublishPaused: 1,
    });
    expect(recovered?.status).toBe("paused");
    expect(recovered?.pause_type).toBe("post_publish_verification");
    expect(recovered?.pause_expires_at).toBeFalsy();
    expect(repo.isPadLocked(task.pad_code)).toBe(false);
  });

  it("supports non-expiring paused tasks for post-publish verification", async () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const task = repo.enqueueTask({
      pad_code: "PAD-NO-EXPIRY",
      platform: "threads",
      caption: "pause me",
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const scheduler = new PublishSchedulerService(repo, async () => ({
      status: "paused",
      pauseType: "post_publish_verification",
      error: "发布动作已执行但结果校验失败，已停止自动重试以避免重复发布",
    }));

    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const recovered = repo.getTask(task.id);
    expect(recovered?.status).toBe("paused");
    expect(recovered?.pause_type).toBe("post_publish_verification");
    expect(recovered?.pause_expires_at).toBeFalsy();
    expect(recovered?.last_error).toContain("避免重复发布");

    await scheduler.pollOnce();
    expect(repo.getTask(task.id)?.attempts).toBe(1);
  });

  it("persists failure evidence for manual intervention", async () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const task = repo.enqueueTask({
      pad_code: "PAD-EVIDENCE",
      platform: "threads",
      caption: "needs evidence",
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const scheduler = new PublishSchedulerService(repo, async () => ({
      status: "failed",
      error: "button not found",
      failureStep: "点击发布按钮",
      screenshotUrl: "https://example.test/failure.jpg",
      samplePath: ".runtime/automatic-script/publish-samples/failure.json",
      manualInterventionRequired: true,
    }));

    await scheduler.pollOnce();
    await scheduler.waitForIdle();

    const recovered = repo.getTask(task.id);
    expect(recovered?.status).toBe("pending");
    expect(recovered?.last_error).toBe("button not found");
    expect(recovered?.failure_step).toBe("点击发布按钮");
    expect(recovered?.failure_screenshot_url).toBe("https://example.test/failure.jpg");
    expect(recovered?.failure_sample_path).toBe(".runtime/automatic-script/publish-samples/failure.json");
    expect(recovered?.manual_intervention_required).toBe(1);
  });

  it("runs at most three different pad codes concurrently and skips duplicate pad codes", async () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const baseTime = Date.now() - 60_000;
    const taskA = repo.enqueueTask({ pad_code: "PAD-1", platform: "threads", caption: "a", scheduled_at: new Date(baseTime).toISOString() });
    const duplicatePadTask = repo.enqueueTask({ pad_code: "PAD-1", platform: "threads", caption: "b", scheduled_at: new Date(baseTime + 1000).toISOString() });
    const taskC = repo.enqueueTask({ pad_code: "PAD-2", platform: "threads", caption: "c", scheduled_at: new Date(baseTime + 2000).toISOString() });
    const taskD = repo.enqueueTask({ pad_code: "PAD-3", platform: "threads", caption: "d", scheduled_at: new Date(baseTime + 3000).toISOString() });
    const fourthDistinctPadTask = repo.enqueueTask({ pad_code: "PAD-4", platform: "threads", caption: "e", scheduled_at: new Date(baseTime + 4000).toISOString() });

    const startedPadCodes: string[] = [];
    const startedTaskIds: string[] = [];
    const resolvers: Array<(result: PublishTaskRunResult) => void> = [];
    const scheduler = new PublishSchedulerService(repo, (task) => {
      startedPadCodes.push(task.pad_code);
      startedTaskIds.push(task.id);
      return new Promise<PublishTaskRunResult>((resolve) => {
        resolvers.push(resolve);
      });
    });

    await scheduler.pollOnce();
    await waitFor(() => startedTaskIds.length === 3);

    expect(startedPadCodes).toHaveLength(3);
    expect(new Set(startedPadCodes).size).toBe(3);
    expect(startedPadCodes.filter((pad) => pad === "PAD-1")).toHaveLength(1);
    expect(startedTaskIds).toEqual([taskA.id, taskC.id, taskD.id]);
    expect(repo.getTask(taskA.id)?.status).toBe("publishing");
    expect(repo.getTask(taskC.id)?.status).toBe("publishing");
    expect(repo.getTask(taskD.id)?.status).toBe("publishing");
    expect(repo.getTask(duplicatePadTask.id)?.status).toBe("pending");
    expect(repo.getTask(fourthDistinctPadTask.id)?.status).toBe("pending");

    for (const resolve of resolvers) resolve({ status: "done" });
    await waitFor(() => repo.getTask(taskA.id)?.status === "done"
      && repo.getTask(taskC.id)?.status === "done"
      && repo.getTask(taskD.id)?.status === "done");

    expect(repo.getTask(taskA.id)?.status).toBe("done");
    expect(repo.getTask(taskC.id)?.status).toBe("done");
    expect(repo.getTask(taskD.id)?.status).toBe("done");
    await waitFor(() => startedTaskIds.length === 5);
    for (const resolve of resolvers.slice(3)) resolve({ status: "done" });
    await scheduler.waitForIdle();
    expect(repo.getTask(duplicatePadTask.id)?.status).toBe("done");
    expect(repo.getTask(fourthDistinctPadTask.id)?.status).toBe("done");
  });

  it("refills an available slot while other publish tasks are still running", async () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const baseTime = Date.now() - 60_000;
    const first = repo.enqueueTask({ pad_code: "PAD-1", platform: "threads", caption: "a", scheduled_at: new Date(baseTime).toISOString() });
    repo.enqueueTask({ pad_code: "PAD-2", platform: "threads", caption: "b", scheduled_at: new Date(baseTime + 1000).toISOString() });
    repo.enqueueTask({ pad_code: "PAD-3", platform: "threads", caption: "c", scheduled_at: new Date(baseTime + 2000).toISOString() });
    const fourth = repo.enqueueTask({ pad_code: "PAD-4", platform: "threads", caption: "d", scheduled_at: new Date(baseTime + 3000).toISOString() });

    const startedTaskIds: string[] = [];
    const resolvers = new Map<string, (result: PublishTaskRunResult) => void>();
    const scheduler = new PublishSchedulerService(repo, (task) => {
      startedTaskIds.push(task.id);
      return new Promise<PublishTaskRunResult>((resolve) => {
        resolvers.set(task.id, resolve);
      });
    });

    await scheduler.pollOnce();
    await waitFor(() => startedTaskIds.length === 3);
    expect(startedTaskIds).not.toContain(fourth.id);

    resolvers.get(first.id)?.({ status: "done" });
    await waitFor(() => startedTaskIds.includes(fourth.id));

    expect(repo.getTask(first.id)?.status).toBe("done");
    expect(repo.getTask(fourth.id)?.status).toBe("publishing");

    for (const [taskId, resolve] of resolvers.entries()) {
      if (repo.getTask(taskId)?.status === "publishing") resolve({ status: "done" });
    }
    await scheduler.waitForIdle();
  });

  it("releases the pad lock if a running task was externally cancelled", async () => {
    const repo = createNodePublishQueueRepository(tempDbPath());
    const task = repo.enqueueTask({
      pad_code: "PAD-CANCEL",
      platform: "threads",
      caption: "cancelled",
      scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    });
    let resolveRun!: (result: PublishTaskRunResult) => void;
    const scheduler = new PublishSchedulerService(repo, () => new Promise<PublishTaskRunResult>((resolve) => {
      resolveRun = resolve;
    }));

    await scheduler.pollOnce();
    await waitFor(() => repo.getTask(task.id)?.status === "publishing");
    expect(repo.isPadLocked("PAD-CANCEL")).toBe(true);

    repo.updateTaskStatus(task.id, "failed", {
      last_error: "manual cancel while running",
      finished_at: new Date().toISOString(),
    });
    resolveRun({ status: "done" });
    await scheduler.waitForIdle();

    expect(repo.getTask(task.id)?.status).toBe("failed");
    expect(repo.isPadLocked("PAD-CANCEL")).toBe(false);
  });
});
