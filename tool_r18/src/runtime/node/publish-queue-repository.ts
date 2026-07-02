import Database from "better-sqlite3";
import path from "node:path";
import { resolveRuntimeFile } from "@/runtime/node/data-dir";

export interface PublishTask {
  id: string;
  archive_id?: string;
  archive_post_id?: string;
  pad_code: string;
  platform: string;
  caption: string;
  media_url?: string;
  status: "pending" | "publishing" | "done" | "failed" | "paused";
  pause_type?: string;
  pause_expires_at?: string;
  attempts: number;
  last_error?: string;
  failure_step?: string;
  failure_screenshot_url?: string;
  failure_sample_path?: string;
  manual_intervention_required?: number;
  scheduled_at: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  telegram_chat_id?: string;
  telegram_target_chat_id?: string;
  telegram_target_group_name?: string;
  telegram_group_content_type?: "free" | "paid";
}

export interface EnqueueTaskInput {
  archive_id?: string;
  archive_post_id?: string;
  pad_code: string;
  platform: string;
  caption: string;
  media_url?: string;
  scheduled_at?: string;
  telegram_chat_id?: string;
  telegram_target_chat_id?: string;
  telegram_target_group_name?: string;
  telegram_group_content_type?: "free" | "paid";
}

export interface TaskFilter {
  status?: string | string[];
  pad_code?: string;
  archive_id?: string;
  telegram_chat_id?: string;
  limit?: number;
}

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS publish_tasks (
  id               TEXT PRIMARY KEY,
  archive_id       TEXT,
  archive_post_id  TEXT,
  pad_code         TEXT NOT NULL,
  platform         TEXT NOT NULL,
  caption          TEXT NOT NULL,
  media_url        TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  pause_type       TEXT,
  pause_expires_at TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  failure_step     TEXT,
  failure_screenshot_url TEXT,
  failure_sample_path TEXT,
  manual_intervention_required INTEGER NOT NULL DEFAULT 0,
  scheduled_at     TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL,
  telegram_chat_id TEXT,
  telegram_target_chat_id TEXT,
  telegram_target_group_name TEXT,
  telegram_group_content_type TEXT
);

CREATE TABLE IF NOT EXISTS pad_locks (
  pad_code          TEXT PRIMARY KEY,
  locked_by_task_id TEXT,
  locked_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_scheduled ON publish_tasks(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_pad_code ON publish_tasks(pad_code, status);
`;

const PAD_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function normalizeAllowedTaskPlatform(platform: unknown): "threads" | "telegram" {
  const value = String(platform || "").trim();
  if (value === "threads" || value === "telegram") return value;
  throw new Error(`Unsupported publish platform: ${value || "(empty)"}`);
}

export interface NodePublishQueueRepository {
  enqueueTask(input: EnqueueTaskInput): PublishTask;
  getTask(id: string): PublishTask | null;
  listTasks(filter?: TaskFilter): PublishTask[];
  updateTaskStatus(
    id: string,
    status: PublishTask["status"],
    opts?: {
      last_error?: string;
      failure_step?: string;
      failure_screenshot_url?: string;
      failure_sample_path?: string;
      manual_intervention_required?: number;
      started_at?: string;
      finished_at?: string;
      pause_type?: string;
      pause_expires_at?: string;
      attempts?: number;
      scheduled_at?: string;
    },
  ): void;
  acquirePadLock(padCode: string, taskId: string): boolean;
  releasePadLock(padCode: string, taskId: string): void;
  releaseAllPadLocks(): number;
  isPadLocked(padCode: string): boolean;
  getDuePendingTasks(limit?: number): PublishTask[];
  getStuckPublishingTasks(timeoutMs?: number): PublishTask[];
  getExpiredPausedTasks(): PublishTask[];
}

export function createNodePublishQueueRepository(dbPath = resolveRuntimeFile("publish_queue.db")): NodePublishQueueRepository {
  const db = new Database(path.resolve(dbPath));
  db.exec(SCHEMA_SQL);
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN telegram_target_chat_id TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN telegram_target_group_name TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN telegram_group_content_type TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN failure_step TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN failure_screenshot_url TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN failure_sample_path TEXT").run();
  } catch {}
  try {
    db.prepare("ALTER TABLE publish_tasks ADD COLUMN manual_intervention_required INTEGER NOT NULL DEFAULT 0").run();
  } catch {}

  return {
    enqueueTask(input: EnqueueTaskInput): PublishTask {
      const now = new Date().toISOString();
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const platform = normalizeAllowedTaskPlatform(input.platform);
      const task: PublishTask = {
        id,
        archive_id: input.archive_id,
        archive_post_id: input.archive_post_id,
        pad_code: input.pad_code,
        platform,
        caption: input.caption,
        media_url: input.media_url,
        status: "pending",
        attempts: 0,
        scheduled_at: input.scheduled_at || now,
        created_at: now,
        telegram_chat_id: input.telegram_chat_id,
        telegram_target_chat_id: input.telegram_target_chat_id,
        telegram_target_group_name: input.telegram_target_group_name,
        telegram_group_content_type: input.telegram_group_content_type === "paid" ? "paid" : input.telegram_group_content_type === "free" ? "free" : undefined,
      };
      db.prepare(`
        INSERT INTO publish_tasks
          (id, archive_id, archive_post_id, pad_code, platform, caption, media_url,
           status, attempts, scheduled_at, created_at, telegram_chat_id, telegram_target_chat_id, telegram_target_group_name, telegram_group_content_type)
        VALUES
          (@id, @archive_id, @archive_post_id, @pad_code, @platform, @caption, @media_url,
           @status, @attempts, @scheduled_at, @created_at, @telegram_chat_id, @telegram_target_chat_id, @telegram_target_group_name, @telegram_group_content_type)
      `).run(task);
      return task;
    },
    getTask(id: string) {
      return db.prepare("SELECT * FROM publish_tasks WHERE id = ?").get(id) as PublishTask | null;
    },
    listTasks(filter: TaskFilter = {}) {
      const conditions: string[] = [];
      const params: any[] = [];
      if (filter.status) {
        if (Array.isArray(filter.status)) {
          conditions.push(`status IN (${filter.status.map(() => "?").join(",")})`);
          params.push(...filter.status);
        } else {
          conditions.push("status = ?");
          params.push(filter.status);
        }
      }
      if (filter.pad_code) {
        conditions.push("pad_code = ?");
        params.push(filter.pad_code);
      }
      if (filter.archive_id) {
        conditions.push("archive_id = ?");
        params.push(filter.archive_id);
      }
      if (filter.telegram_chat_id) {
        conditions.push("telegram_chat_id = ?");
        params.push(filter.telegram_chat_id);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filter.limit ? `LIMIT ${filter.limit}` : "";
      return db.prepare(`SELECT * FROM publish_tasks ${where} ORDER BY scheduled_at ASC ${limit}`).all(...params) as PublishTask[];
    },
    updateTaskStatus(id, status, opts = {}) {
      const sets: string[] = ["status = @status"];
      const params: any = { id, status };
      if (opts.last_error !== undefined) { sets.push("last_error = @last_error"); params.last_error = opts.last_error; }
      if (opts.failure_step !== undefined) { sets.push("failure_step = @failure_step"); params.failure_step = opts.failure_step; }
      if (opts.failure_screenshot_url !== undefined) { sets.push("failure_screenshot_url = @failure_screenshot_url"); params.failure_screenshot_url = opts.failure_screenshot_url; }
      if (opts.failure_sample_path !== undefined) { sets.push("failure_sample_path = @failure_sample_path"); params.failure_sample_path = opts.failure_sample_path; }
      if (opts.manual_intervention_required !== undefined) { sets.push("manual_intervention_required = @manual_intervention_required"); params.manual_intervention_required = opts.manual_intervention_required; }
      if (opts.started_at !== undefined) { sets.push("started_at = @started_at"); params.started_at = opts.started_at; }
      if (opts.finished_at !== undefined) { sets.push("finished_at = @finished_at"); params.finished_at = opts.finished_at; }
      if (opts.pause_type !== undefined) { sets.push("pause_type = @pause_type"); params.pause_type = opts.pause_type; }
      if (opts.pause_expires_at !== undefined) { sets.push("pause_expires_at = @pause_expires_at"); params.pause_expires_at = opts.pause_expires_at; }
      if (opts.attempts !== undefined) { sets.push("attempts = @attempts"); params.attempts = opts.attempts; }
      if (opts.scheduled_at !== undefined) { sets.push("scheduled_at = @scheduled_at"); params.scheduled_at = opts.scheduled_at; }
      db.prepare(`UPDATE publish_tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
    },
    acquirePadLock(padCode, taskId) {
      try {
        db.prepare("UPDATE pad_locks SET locked_by_task_id = NULL, locked_at = NULL WHERE locked_at IS NOT NULL AND locked_at <= ?")
          .run(new Date(Date.now() - PAD_LOCK_STALE_MS).toISOString());
        db.prepare(`
          INSERT INTO pad_locks (pad_code, locked_by_task_id, locked_at)
          VALUES (?, ?, ?)
          ON CONFLICT(pad_code) DO UPDATE SET
            locked_by_task_id = excluded.locked_by_task_id,
            locked_at = excluded.locked_at
          WHERE locked_by_task_id IS NULL
        `).run(padCode, taskId, new Date().toISOString());
        const row = db.prepare("SELECT locked_by_task_id FROM pad_locks WHERE pad_code = ?").get(padCode) as any;
        return row?.locked_by_task_id === taskId;
      } catch {
        return false;
      }
    },
    releasePadLock(padCode, taskId) {
      db.prepare("UPDATE pad_locks SET locked_by_task_id = NULL, locked_at = NULL WHERE pad_code = ? AND locked_by_task_id = ?").run(padCode, taskId);
    },
    releaseAllPadLocks() {
      const result = db.prepare("UPDATE pad_locks SET locked_by_task_id = NULL, locked_at = NULL WHERE locked_by_task_id IS NOT NULL").run();
      return Number(result.changes || 0);
    },
    isPadLocked(padCode) {
      db.prepare("UPDATE pad_locks SET locked_by_task_id = NULL, locked_at = NULL WHERE locked_at IS NOT NULL AND locked_at <= ?")
        .run(new Date(Date.now() - PAD_LOCK_STALE_MS).toISOString());
      const row = db.prepare("SELECT locked_by_task_id FROM pad_locks WHERE pad_code = ?").get(padCode) as any;
      return Boolean(row?.locked_by_task_id);
    },
    getDuePendingTasks(limit = 50) {
      const now = new Date().toISOString();
      return db.prepare(`
        SELECT * FROM publish_tasks
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT ?
      `).all(now, limit) as PublishTask[];
    },
    getStuckPublishingTasks(timeoutMs = 15 * 60 * 1000) {
      const cutoff = new Date(Date.now() - timeoutMs).toISOString();
      return db.prepare(`
        SELECT * FROM publish_tasks
        WHERE status = 'publishing' AND started_at IS NOT NULL AND started_at <= ?
      `).all(cutoff) as PublishTask[];
    },
    getExpiredPausedTasks() {
      const now = new Date().toISOString();
      return db.prepare(`
        SELECT * FROM publish_tasks
        WHERE status = 'paused' AND pause_expires_at IS NOT NULL AND pause_expires_at <= ?
      `).all(now) as PublishTask[];
    },
  };
}
