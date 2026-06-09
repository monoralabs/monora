import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface IntegrateResult {
  /** Merged cleanly (or nothing to merge) - safe to push. */
  ok: boolean;
  /** Set when a real conflict was left in the working tree (same lines, same
   *  file). The merge is in progress with conflict markers, for the user (or an
   *  agent) to resolve and re-save. */
  conflictFiles?: string[];
}

/** A commit identity for the merge commit, supplied ONLY when the repo/user has
 *  none, so a bare agent or CI box can merge without clobbering a real author. */
async function identityArgs(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const has = async (key: string) =>
    exec("git", ["-C", dest, "config", key], { env })
      .then((r) => r.stdout.trim() !== "")
      .catch(() => false);
  if ((await has("user.email")) && (await has("user.name"))) return [];
  return ["-c", "user.name=Monora", "-c", "user.email=connector@monora.ai"];
}

/** The conflicted files left in the working tree after a failed merge, or [].
 *  An empty list means the failure was NOT a line-level conflict. */
async function conflictedFiles(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["-C", dest, "diff", "--name-only", "--diff-filter=U"],
    { env },
  ).catch(() => ({ stdout: "" }) as { stdout: string });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Do HEAD and its configured upstream share any ancestor? `false` means the
 *  remote was re-rooted (the common case: the ingest job re-created the folder's
 *  repo with a fresh root commit), so HEAD and @{u} are unrelated histories. */
async function sharesHistoryWithUpstream(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return exec("git", ["-C", dest, "merge-base", "HEAD", "@{u}"], { env })
    .then((r) => r.stdout.trim() !== "")
    .catch(() => false);
}

/**
 * Integrate the upstream into the local branch the way git always has: a clean
 * 3-way MERGE. When the two sides touched different lines/files (the common
 * case for a multi-writer brain - two machines, the ingest job, agents) it
 * merges silently. When they touched the same lines it leaves conflict markers
 * in place (NOT aborted) and reports the files, so that folder can be resolved
 * while every other folder still saves. Never force-pushes, never discards a
 * side - so no divergence resolution can lose data.
 *
 * Unrelated histories: when the remote was re-rooted (the ingest job rebuilds a
 * folder's repo from scratch, giving it a fresh root commit), HEAD and the
 * upstream share no ancestor and a plain `git pull` aborts with "refusing to
 * merge unrelated histories". That is an expected, recoverable state for a
 * brain, not an error - so we retry once with --allow-unrelated-histories. The
 * merge is still a union (both roots survive in history, no side is discarded),
 * so the no-data-loss invariant holds; only same-file/same-region edits become
 * real conflicts, reported the same way.
 *
 * Throws only on a non-conflict failure (network, auth, ...), after aborting any
 * half-done merge so the folder is left usable.
 */
export async function mergeUpstream(
  dest: string,
  env: NodeJS.ProcessEnv,
  authArgs: string[] = [],
): Promise<IntegrateResult> {
  const ident = await identityArgs(dest, env);
  const pull = (extra: string[]) =>
    exec(
      "git",
      [...authArgs, ...ident, "-C", dest, "pull", "--no-rebase", "--no-edit", ...extra],
      { env },
    );
  try {
    await pull([]);
    return { ok: true };
  } catch (e) {
    // A line-level conflict from the plain pull: leave the markers for the user.
    const conflicts = await conflictedFiles(dest, env);
    if (conflicts.length > 0) return { ok: false, conflictFiles: conflicts };

    // Not a conflict. The expected non-conflict failure is a re-rooted remote
    // (unrelated histories); anything else (network, auth) is a real error.
    if (!(await sharesHistoryWithUpstream(dest, env))) {
      try {
        await pull(["--allow-unrelated-histories"]);
        return { ok: true };
      } catch {
        const rerootConflicts = await conflictedFiles(dest, env);
        if (rerootConflicts.length > 0) {
          return { ok: false, conflictFiles: rerootConflicts };
        }
        // Still no conflict - fall through to abort + throw the original error.
      }
    }

    // Not a conflict (e.g. the network dropped): undo any partial merge and
    // surface the real error to the caller.
    await exec("git", ["-C", dest, "merge", "--abort"], { env }).catch(() => {});
    throw e;
  }
}
