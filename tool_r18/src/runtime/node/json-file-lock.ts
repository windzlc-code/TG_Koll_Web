import fs from "node:fs";
import path from "node:path";

const RETRY_DELAY_MS = 25;
const MAX_RETRIES = 10;
const STALE_LOCK_MS = 60_000;

export function withExclusiveJsonFileLock(filePath: string, callback: () => void): boolean {
  const lockFile = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let lockFd: number | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      lockFd = fs.openSync(lockFile, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lockFile);
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
      fs.unlinkSync(lockFile);
    } catch {
      // A stale-lock cleanup race does not affect the already completed write.
    }
  }
}
