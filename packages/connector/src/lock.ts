import { open, rm, readFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * One mutating command per workspace at a time. `sync`, `save` and `collapse`
 * all rewrite the same working trees and `.monora/` index; two running at once
 * (a cron sync under a manual save, two agents on one machine) can interleave
 * git operations mid-merge. The lock is a `wx`-created file holding the
 * holder's pid: same-machine concurrency is the real risk (different machines
 * converge through git itself), so a pid liveness check is enough to clear a
 * lock left behind by a crash.
 */

interface LockHolder {
  pid: number;
  command: string;
  startedAt: string;
}

export function lockPath(workspace: string): string {
  return path.join(workspace, ".monora", "lock");
}

async function tryAcquire(file: string, payload: string): Promise<boolean> {
  try {
    const handle = await open(file, "wx"); // fails if it exists: atomic acquire
    await handle.writeFile(payload);
    await handle.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but owned by someone else -> alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withWorkspaceLock<T>(
  workspace: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  const file = lockPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  const payload =
    JSON.stringify({
      pid: process.pid,
      command,
      startedAt: new Date().toISOString(),
    } satisfies LockHolder) + "\n";

  let acquired = await tryAcquire(file, payload);
  if (!acquired) {
    const holder = await readFile(file, "utf8")
      .then((s) => {
        try {
          return JSON.parse(s) as LockHolder;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    // A crash leaves the file behind with a dead pid: clear it and retry. An
    // unreadable file is NOT treated as stale - it may not be ours.
    if (
      holder &&
      typeof holder.pid === "number" &&
      holder.pid !== process.pid &&
      !pidAlive(holder.pid)
    ) {
      await rm(file, { force: true });
      acquired = await tryAcquire(file, payload);
    }
    if (!acquired) {
      const who = holder
        ? ` (\`monora ${holder.command}\`, pid ${holder.pid}, since ${holder.startedAt})`
        : "";
      throw new Error(
        `another monora command is already running in this workspace${who} - wait for it to finish, or delete .monora/lock if it crashed`,
      );
    }
  }

  try {
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}
