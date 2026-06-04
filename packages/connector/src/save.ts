import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

export interface SaveOptions {
  /** Workspace root (the dir you passed to `monora sync`). */
  workspace: string;
  /**
   * Commit message used for every folder that has changes. If omitted, a plain
   * default is used; pass `-m` for something meaningful.
   */
  message?: string;
  concurrency?: number;
}

/** What happened to one folder when we tried to save it. */
export type SaveAction =
  | "saved" // had changes: committed and pushed
  | "pushed" // no new changes, but local commits were waiting to push
  | "clean"; // nothing to commit, nothing to push

export interface SaveResult {
  saved: { mountPath: string; action: SaveAction }[];
  errors: { mountPath: string; error: string }[];
}

const DEFAULT_MESSAGE = "Update from monora save";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface WorkspaceMeta {
  orgId: string;
  entries: { mountPath: string; repoName: string }[];
}

async function readWorkspaceMeta(
  workspace: string,
): Promise<WorkspaceMeta | null> {
  try {
    return JSON.parse(
      await readFile(path.join(workspace, ".monora", "manifest.json"), "utf8"),
    ) as WorkspaceMeta;
  } catch {
    return null;
  }
}

/** Number of local commits not yet on the upstream branch (0 if no upstream). */
async function commitsAhead(dest: string, env: NodeJS.ProcessEnv): Promise<number> {
  // No upstream configured -> treat as nothing to push (a fresh repo with no
  // remote tracking ref). Folders cloned by `sync` always have one.
  const upstream = await exec(
    "git",
    ["-C", dest, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { env },
  )
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (!upstream) return 0;
  const { stdout } = await exec(
    "git",
    ["-C", dest, "rev-list", "--count", `${upstream}..HEAD`],
    { env },
  );
  return Number(stdout.trim()) || 0;
}

/** Args that supply a commit identity ONLY when the repo/user has none, so a
 *  bare agent or CI box can still commit without clobbering a real author. */
async function identityArgs(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const has = async (key: string) =>
    exec("git", ["-C", dest, "config", key], { env })
      .then((r) => r.stdout.trim() !== "")
      .catch(() => false);
  if ((await has("user.email")) && (await has("user.name"))) return [];
  return [
    "-c",
    "user.name=Monora",
    "-c",
    "user.email=connector@monora.ai",
  ];
}

async function saveEntry(
  mountPath: string,
  workspace: string,
  message: string,
): Promise<SaveAction> {
  const dest = path.join(workspace, mountPath);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  const { stdout: status } = await exec(
    "git",
    ["-C", dest, "status", "--porcelain"],
    { env },
  );
  let committed = false;
  if (status.trim() !== "") {
    await exec("git", ["-C", dest, "add", "-A"], { env });
    const ident = await identityArgs(dest, env);
    await exec(
      "git",
      [...ident, "-C", dest, "commit", "-m", message],
      { env },
    );
    committed = true;
  }

  if ((await commitsAhead(dest, env)) > 0) {
    // The credential helper wired by `sync` authenticates this push - no token
    // or prompt needed. A read-only folder is rejected server-side and surfaces
    // here as an error for that folder only.
    await exec("git", ["-C", dest, "push"], { env });
    return committed ? "saved" : "pushed";
  }
  return committed ? "saved" : "clean";
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        await worker(item);
      }
    }),
  );
}

/**
 * Commit and push every folder in the workspace that has local changes - one
 * command for the whole tree instead of a `git add`/`commit`/`push` per folder.
 *
 * Each folder is its own repo, so each gets its own commit (same message). Push
 * uses the credential helper `sync` already wired into every folder, so `save`
 * needs no token of its own. Folders with nothing to save are left untouched;
 * a `read`-only folder that somehow has changes fails server-side on push and
 * is reported as an error without blocking the others.
 */
export async function save(opts: SaveOptions): Promise<SaveResult> {
  const meta = await readWorkspaceMeta(opts.workspace);
  if (!meta) {
    throw new Error("no Monora workspace here (run `monora sync` first)");
  }
  const message = opts.message?.trim() || DEFAULT_MESSAGE;
  const result: SaveResult = { saved: [], errors: [] };

  await runPool(meta.entries, opts.concurrency ?? 8, async (entry) => {
    const dest = path.join(opts.workspace, entry.mountPath);
    if (!(await exists(path.join(dest, ".git")))) return; // not mounted; skip
    try {
      const action = await saveEntry(entry.mountPath, opts.workspace, message);
      result.saved.push({ mountPath: entry.mountPath, action });
    } catch (e) {
      result.errors.push({
        mountPath: entry.mountPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return result;
}
