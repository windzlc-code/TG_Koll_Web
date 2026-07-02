import { createNodePublishQueueRepository, type EnqueueTaskInput } from "@/runtime/node/publish-queue-repository";

interface PublishQueueWorkerInput {
  action: "enqueue" | "list" | "retry" | "cancel";
  task?: EnqueueTaskInput;
  taskId?: string;
  status?: string | string[];
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    printJson({ ok: false, error: "missing JSON input" });
    process.exitCode = 1;
    return;
  }

  const input = JSON.parse(raw) as PublishQueueWorkerInput;
  const repo = createNodePublishQueueRepository();

  if (input.action === "enqueue") {
    if (!input.task) {
      printJson({ ok: false, error: "missing task" });
      process.exitCode = 1;
      return;
    }
    printJson({ ok: true, task: repo.enqueueTask(input.task) });
    return;
  }

  if (input.action === "list") {
    printJson({ ok: true, tasks: repo.listTasks({ status: input.status }) });
    return;
  }

  if (input.action === "retry") {
    if (!input.taskId) {
      printJson({ ok: false, error: "missing taskId" });
      process.exitCode = 1;
      return;
    }
    repo.updateTaskStatus(input.taskId, "pending", {
      scheduled_at: new Date().toISOString(),
      last_error: undefined as any,
      finished_at: undefined as any,
    });
    printJson({ ok: true, task: repo.getTask(input.taskId) });
    return;
  }

  if (input.action === "cancel") {
    if (!input.taskId) {
      printJson({ ok: false, error: "missing taskId" });
      process.exitCode = 1;
      return;
    }
    repo.updateTaskStatus(input.taskId, "failed", {
      last_error: "已手动取消",
      finished_at: new Date().toISOString(),
    });
    printJson({ ok: true, task: repo.getTask(input.taskId) });
    return;
  }

  printJson({ ok: false, error: `unsupported action: ${input.action}` });
  process.exitCode = 1;
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
