import { PublishSchedulerService, type PublishTaskRunResult } from "@/core/publish/publish-scheduler";
import { createNodePublishQueueRepository } from "@/runtime/node/publish-queue-repository";

interface VerifySkillPathInput {
  archiveId?: string;
  queueTask?: {
    archive_id?: string;
    archive_post_id?: string;
    pad_code: string;
    platform: string;
    caption: string;
    media_url?: string;
    scheduled_at?: string;
    telegram_chat_id?: string;
  };
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const raw = process.argv[2];
  const input = raw ? JSON.parse(raw) as VerifySkillPathInput : {};
  const repo = createNodePublishQueueRepository();
  let enqueuedId: string | undefined;

  if (input.queueTask) {
    const task = repo.enqueueTask(input.queueTask);
    enqueuedId = task.id;
  }

  const transitions: Array<Record<string, unknown>> = [];
  const scheduler = new PublishSchedulerService(
    repo,
    async () => ({ status: "done" } as PublishTaskRunResult),
    {
      onTaskStatusChange: (taskId, status, extra) => {
        transitions.push({ taskId, status, ...(extra || {}) });
      },
    },
  );

  await scheduler.pollOnce();
  await scheduler.waitForIdle(1000).catch(() => undefined);

  printJson({
    ok: true,
    enqueuedId,
    tasks: repo.listTasks({ status: ["pending", "publishing", "done", "failed", "paused"] }),
    transitions,
  });
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
