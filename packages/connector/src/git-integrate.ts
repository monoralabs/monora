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

/**
 * Integrate the upstream into the local branch the way git always has: a clean
 * 3-way MERGE. When the two sides touched different lines/files (the common
 * case for a multi-writer brain - two machines, the ingest job, agents) it
 * merges silently. When they touched the same lines it leaves conflict markers
 * in place (NOT aborted) and reports the files, so that folder can be resolved
 * while every other folder still saves. Never force-pushes, never discards a
 * side - so no divergence resolution can lose data.
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
  try {
    await exec(
      "git",
      [...authArgs, ...ident, "-C", dest, "pull", "--no-rebase", "--no-edit"],
      { env },
    );
    return { ok: true };
  } catch (e) {
    const { stdout } = await exec(
      "git",
      ["-C", dest, "diff", "--name-only", "--diff-filter=U"],
      { env },
    ).catch(() => ({ stdout: "" }) as { stdout: string });
    const files = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (files.length > 0) {
      // A real conflict: leave the markers in place for resolution.
      return { ok: false, conflictFiles: files };
    }
    // Not a conflict (e.g. the network dropped): undo any partial merge and
    // surface the real error to the caller.
    await exec("git", ["-C", dest, "merge", "--abort"], { env }).catch(() => {});
    throw e;
  }
}
