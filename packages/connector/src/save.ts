import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import path from "node:path";
import { gitAuthArgs, setupPushCredentials } from "./sync";
import {
  readPending,
  writePending,
  createFolderRemote,
  archiveFolderRemote,
  fetchServerManifest,
  type PendingCreate,
} from "./lifecycle";
import { mergeUpstream } from "./git-integrate";

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
  /** Proxy base URL + token, needed for the lifecycle reconcile (create/archive).
   *  When omitted, `save` only does the M pass (commit + push existing folders). */
  baseUrl?: string;
  token?: string;
  /** Show the A/M/D plan without changing anything (local or remote). */
  dryRun?: boolean;
  /** Override the catastrophic-delete guard (e.g. you really did remove most of
   *  the workspace on purpose). */
  force?: boolean;
}

/** What happened to one folder when we tried to save it. */
export type SaveAction =
  | "saved" // had changes: committed and pushed
  | "pushed" // no new changes, but local commits were waiting to push
  | "clean"; // nothing to commit, nothing to push

export interface SaveResult {
  saved: { mountPath: string; action: SaveAction }[];
  /** New folders created on the server and pushed (the "A"). */
  created: { mountPath: string }[];
  /** Folders archived because they vanished from disk (the "D"). */
  archived: { mountPath: string }[];
  /** D candidates NOT acted on because the guard tripped (only without --force). */
  guarded: string[];
  /** Folders left with merge conflict markers after the remote diverged on the
   *  same lines - resolve these and re-save. Every other folder still saved. */
  conflicts: { mountPath: string; files: string[] }[];
  errors: { mountPath: string; error: string }[];
  /** Set on a --dry-run: the reconcile plan, nothing executed. */
  plan?: { create: string[]; delete: string[] };
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
  entries: { mountPath: string; repoName: string; folderId: string }[];
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
  return ["-c", "user.name=Monora", "-c", "user.email=connector@monora.ai"];
}

interface EntryOutcome {
  action: SaveAction;
  /** Files left conflicted after a divergent merge (folder needs resolving). */
  conflictFiles?: string[];
}

async function saveEntry(
  mountPath: string,
  workspace: string,
  message: string,
  token?: string,
): Promise<EntryOutcome> {
  const dest = path.join(workspace, mountPath);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Push with the connector's token as an inline auth header - the same way
  // `sync` and `collapse` authenticate. A bare `git push` here would instead
  // depend on the on-disk credential-store file, which is empty until a `sync`
  // populates it; that made `save` commit fine but fail to push (no terminal
  // prompt) on a freshly-set-up or never-synced machine.
  const auth = token ? gitAuthArgs(token) : [];

  const { stdout: status } = await exec(
    "git",
    ["-C", dest, "status", "--porcelain"],
    { env },
  );
  const ident = await identityArgs(dest, env);
  let committed = false;
  if (status.trim() !== "") {
    await exec("git", ["-C", dest, "add", "-A"], { env });
    await exec("git", [...ident, "-C", dest, "commit", "-m", message], { env });
    committed = true;
  }

  if ((await commitsAhead(dest, env)) > 0) {
    try {
      await exec("git", [...auth, "-C", dest, "push"], { env });
    } catch {
      // The remote diverged (another machine, the ingest job, an agent pushed).
      // Integrate the git way - merge, never force - then push the merge. A real
      // line-level conflict is left in place and reported; the folder is not
      // pushed, but every other folder still saves.
      const merged = await mergeUpstream(dest, env, auth);
      if (!merged.ok) {
        return { action: committed ? "saved" : "clean", conflictFiles: merged.conflictFiles };
      }
      await exec("git", [...auth, "-C", dest, "push"], { env });
    }
    return { action: committed ? "saved" : "pushed" };
  }
  return { action: committed ? "saved" : "clean" };
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
 * Would this batch of deletions wipe out most of the workspace? A folder gone
 * from disk normally means "the user deleted it", but a wrong working dir, a
 * half-done clone, or an `rm -rf` slip would make EVERY folder look deleted -
 * and a soft-delete is still a delete the others see. So we refuse en-masse
 * deletes unless forced: all folders missing, or a majority (>=3) missing.
 */
function deleteGuardTrips(missing: number, total: number): boolean {
  if (total === 0 || missing === 0) return false;
  if (missing === total) return true;
  return missing >= 3 && missing > total / 2;
}

/** Carve a newly-promoted folder out of its parent's working tree by adding it
 *  to the parent repo's `.gitignore`, so the parent stops tracking that subpath
 *  (it is its own repo now). The parent's `.gitignore` change is itself a normal
 *  edit, committed + pushed by the M pass that runs right after. */
async function carveOutFromParent(
  workspace: string,
  parentMount: string,
  childRelPath: string,
): Promise<void> {
  const parentDir = path.join(workspace, parentMount);
  if (!(await exists(path.join(parentDir, ".git")))) return; // parent not a repo
  const ignoreFile = path.join(parentDir, ".gitignore");
  const line = `/${childRelPath}/`;
  let current = "";
  try {
    current = await readFile(ignoreFile, "utf8");
  } catch {
    current = "";
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === line)) return; // already
  const next = current && !current.endsWith("\n") ? `${current}\n${line}\n` : `${current}${line}\n`;
  await writeFile(ignoreFile, next);
  // Drop the now-ignored subpath from the parent's index if it was tracked, so
  // the carve-out actually removes it from the parent repo (not just future
  // commits). Best-effort: a never-tracked path makes this a no-op.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  await exec("git", ["-C", parentDir, "rm", "-r", "--cached", "--ignore-unmatch", childRelPath], {
    env,
  }).catch(() => {});
}

/** Create a staged folder on the server and push the local directory's current
 *  content into its fresh repo. */
async function applyCreate(
  workspace: string,
  create: PendingCreate,
  baseUrl: string,
  token: string,
): Promise<void> {
  const dest = path.join(workspace, create.mountPath);
  if (!(await exists(dest))) {
    throw new Error(`staged folder ${create.mountPath} no longer exists on disk`);
  }
  const created = await createFolderRemote(baseUrl, token, create.brainId, {
    slug: create.slug,
    name: create.name,
    path: create.path,
    parentFolderId: create.parentFolderId,
  });

  // The parent stops tracking this subtree (it is its own repo now): carve the
  // subpath out of whichever repo's working tree currently holds it.
  if (create.parentMount && create.mountPath.startsWith(`${create.parentMount}/`)) {
    const childRel = create.mountPath.slice(create.parentMount.length + 1);
    await carveOutFromParent(workspace, create.parentMount, childRel);
  }

  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const auth = gitAuthArgs(token);
  const credFile = await setupPushCredentials(baseUrl, token);
  const ident = await identityArgs(dest, env);
  if (!(await exists(path.join(dest, ".git")))) {
    await exec("git", ["-C", dest, "init", "-b", "main"], { env });
    await exec("git", ["-C", dest, "remote", "add", "origin", created.cloneUrl], { env });
  }
  await exec("git", ["-C", dest, "add", "-A"], { env });
  await exec(
    "git",
    [...ident, "-C", dest, "commit", "-m", `Create ${create.mountPath}`],
    { env },
  ).catch(() => {}); // empty dir -> nothing to commit; still wire the remote
  await exec("git", [...auth, "-C", dest, "push", "-u", "origin", "HEAD:main"], { env });
  if (credFile) {
    await exec("git", ["-C", dest, "config", "credential.helper", `store --file=${credFile}`], { env });
    await exec("git", ["-C", dest, "config", "credential.useHttpPath", "false"], { env });
  }
}

/**
 * Commit and push every folder with local changes (M), create folders staged
 * with `monora add` (A), and archive folders that vanished from disk (D) - one
 * command that reconciles the whole workspace to the server, the way `git push`
 * reconciles a branch. Each folder is its own repo, so each M gets its own
 * commit. Deletions are soft (recoverable from the trash with `monora restore`)
 * and guarded against an accidental en-masse wipe.
 */
export async function save(opts: SaveOptions): Promise<SaveResult> {
  const meta = await readWorkspaceMeta(opts.workspace);
  if (!meta) {
    throw new Error("no Monora workspace here (run `monora sync` first)");
  }
  const message = opts.message?.trim() || DEFAULT_MESSAGE;
  const result: SaveResult = {
    saved: [],
    created: [],
    archived: [],
    guarded: [],
    conflicts: [],
    errors: [],
  };

  const canReconcile = Boolean(opts.baseUrl && opts.token);
  const pending = canReconcile ? await readPending(opts.workspace) : { creates: [] };

  // D candidates: a folder the SERVER still has AND we have on disk, whose
  // directory is now gone. The match key is `repoName` (the brain-id-based
  // identity, stable) - NOT the mount path, which drifts: a cross-org manifest
  // qualifies colliding brain slugs (`monora-guide-<org8>/...`), so the server's
  // mount path may differ from where the folder actually sits locally. We take
  // the folder id from the server and the on-disk path from the local index.
  // A server folder we never mounted locally is newly-shared, not a deletion -
  // so it is ignored here.
  const dCandidates: { mountPath: string; folderId: string }[] = [];
  let deleteTotal = 0;
  if (canReconcile) {
    const localByRepo = new Map(meta.entries.map((e) => [e.repoName, e.mountPath]));
    const server = await fetchServerManifest(opts.baseUrl!, opts.token!);
    for (const e of server) {
      const localMount = localByRepo.get(e.repoName);
      if (!localMount) continue; // not something we have on disk
      deleteTotal++;
      if (!(await exists(path.join(opts.workspace, localMount)))) {
        dCandidates.push({ mountPath: localMount, folderId: e.folderId });
      }
    }
  }
  const guardTrips =
    !opts.force && deleteGuardTrips(dCandidates.length, deleteTotal);
  const deletes = guardTrips ? [] : dCandidates;
  if (guardTrips) result.guarded = dCandidates.map((e) => e.mountPath);

  if (opts.dryRun) {
    result.plan = {
      create: pending.creates.map((c) => c.mountPath),
      delete: deletes.map((e) => e.mountPath),
    };
    // Still report which M folders are dirty, without committing.
    return result;
  }

  // A first: creating a folder may carve a path out of its parent (a .gitignore
  // edit), which the M pass below then commits + pushes in the same run.
  if (canReconcile && pending.creates.length > 0) {
    const remaining: PendingCreate[] = [];
    for (const create of pending.creates) {
      try {
        await applyCreate(opts.workspace, create, opts.baseUrl!, opts.token!);
        result.created.push({ mountPath: create.mountPath });
      } catch (e) {
        result.errors.push({
          mountPath: create.mountPath,
          error: e instanceof Error ? e.message : String(e),
        });
        remaining.push(create); // keep it staged so a re-run can retry
      }
    }
    await writePending(opts.workspace, { creates: remaining });
  }

  // M: commit + push every still-present folder with changes.
  await runPool(meta.entries, opts.concurrency ?? 8, async (entry) => {
    const dest = path.join(opts.workspace, entry.mountPath);
    if (!(await exists(path.join(dest, ".git")))) return; // gone or not mounted
    try {
      const outcome = await saveEntry(entry.mountPath, opts.workspace, message, opts.token);
      if (outcome.conflictFiles) {
        result.conflicts.push({
          mountPath: entry.mountPath,
          files: outcome.conflictFiles,
        });
      }
      result.saved.push({ mountPath: entry.mountPath, action: outcome.action });
    } catch (e) {
      result.errors.push({
        mountPath: entry.mountPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // D: archive folders that vanished from disk (soft-delete, recoverable).
  if (canReconcile) {
    for (const entry of deletes) {
      try {
        await archiveFolderRemote(opts.baseUrl!, opts.token!, entry.folderId);
        result.archived.push({ mountPath: entry.mountPath });
      } catch (e) {
        result.errors.push({
          mountPath: entry.mountPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return result;
}
