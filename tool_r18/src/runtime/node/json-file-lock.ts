import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RETRY_DELAY_MS = Math.max(10, Number(process.env.JSON_FILE_LOCK_RETRY_MS || 25));
const WAIT_MS = Math.max(250, Number(process.env.JSON_FILE_LOCK_WAIT_MS || 5_000));
const STALE_LOCK_MS = Math.max(30_000, Number(process.env.JSON_FILE_LOCK_STALE_MS || 2 * 60_000));

type LockRecord = { pid: number; token: string; createdAt: number };

function readLockRecord(lockFile: string): LockRecord | null {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function withExclusiveJsonFileLock(filePath: string, callback: () => void): boolean {
  const lockFile = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let lockFd: number | undefined;
  const deadline = Date.now() + WAIT_MS;
  const record: LockRecord = { pid: process.pid, token: crypto.randomUUID(), createdAt: Date.now() };
  while (Date.now() < deadline) {
    try {
      lockFd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(lockFd, JSON.stringify(record), "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const holder = readLockRecord(lockFile);
        const stale = holder
          ? !processIsAlive(Number(holder.pid))
          : Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS;
        if (stale) {
          const current = readLockRecord(lockFile);
          if (!holder?.token || current?.token === holder.token) fs.unlinkSync(lockFile);
        }
      } catch {
        // The owner may have released the lock while it was inspected.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS);
    }
  }
  if (lockFd === undefined) return false;
  try {
    callback();
    return true;
  } finally {
    fs.closeSync(lockFd);
    try {
      const current = readLockRecord(lockFile);
      if (current?.token === record.token) fs.unlinkSync(lockFile);
    } catch {
      // A stale-lock cleanup race does not affect the already completed write.
    }
  }
}
