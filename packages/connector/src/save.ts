import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, mkdir, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { gitAuthArgs, setupPushCredentials, dropStaleAuthHeader } from "./sync";
import {
  readPending,
  writePending,
  createFolderRemote,
  archiveFolderRemote,
  fetchServerManifest,
  type PendingCreate,
} from "./lifecycle";
import { mergeUpstream, conflictedFiles } from "./git-integrate";
import { withWorkspaceLock } from "./lock";

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
  plan?: { create: string[]; delete: string[]; changed: string[] };
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
  let raw: string;
  try {
    raw = await readFile(path.join(workspace, ".monora", "manifest.json"), "utf8");
  } catch {
    return null; // not a workspace
  }
  try {
    return JSON.parse(raw) as WorkspaceMeta;
  } catch {
    // A present-but-unparseable index is corruption, not "no workspace" - say
    // so instead of the misleading "run monora sync first".
    throw new Error(
      ".monora/manifest.json is unreadable (corrupt or truncated) - run `monora sync` to rebuild it",
    );
  }
}

/** Local commits not yet on the server. With an upstream this is the usual
 *  `@{u}..HEAD` count; without one (the user branched, or tracking was lost)
 *  it counts commits on no `origin/*` branch at all, so unpushed work is still
 *  seen instead of silently stranded. */
async function aheadInfo(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<{ upstream: string; ahead: number }> {
  const upstream = await exec(
    "git",
    ["-C", dest, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { env },
  )
    .then((r) => r.stdout.trim())
    .catch(() => "");
  const range = upstream
    ? ["rev-list", "--count", `${upstream}..HEAD`]
    : ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"];
  const ahead = await exec("git", ["-C", dest, ...range], { env })
    .then((r) => Number(r.stdout.trim()) || 0)
    .catch(() => 0); // unborn HEAD -> nothing to push
  return { upstream, ahead };
}

/** True when the folder has anything save would act on: a dirty working tree
 *  or local commits not yet pushed. Used by --dry-run to fill the M plan. */
async function hasPendingWork(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const { stdout } = await exec("git", ["-C", dest, "status", "--porcelain"], {
    env,
  });
  if (stdout.trim() !== "") return true;
  return (await aheadInfo(dest, env)).ahead > 0;
}

/** Repos found at or below `relDir` (a path relative to `base`), stopping at
 *  the first `.git` on each branch of the walk. Untracked dirs collapse to
 *  their TOPMOST dir in porcelain output, so a clone at `sub/nested/` only
 *  shows as `?? sub/` - the walk finds it anyway. */
async function findEmbeddedRepos(
  base: string,
  relDir: string,
  out: string[],
  depth = 0,
): Promise<void> {
  if (depth > 8) return;
  const abs = path.join(base, relDir);
  if (await exists(path.join(abs, ".git"))) {
    out.push(relDir);
    return;
  }
  const entries = await readdir(abs, { withFileTypes: true }).catch(
    (): Dirent[] => [],
  );
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".git") continue;
    await findEmbeddedRepos(base, path.posix.join(relDir, e.name), out, depth + 1);
  }
}

/** Subpaths of this folder that are themselves git repos and must never be
 *  committed by it: nested mounted folders (they save through their own entry)
 *  plus any repo the user cloned inside - `git add -A` would otherwise record
 *  them as bare gitlinks, which arrive on every other machine as broken empty
 *  dirs. Uses `-z` so paths with spaces/unicode come through unquoted. */
export async function embeddedRepoExcludes(
  dest: string,
  env: NodeJS.ProcessEnv,
  nestedMounts: string[],
): Promise<string[]> {
  const out = new Set(nestedMounts);
  const { stdout } = await exec(
    "git",
    ["-C", dest, "status", "--porcelain", "-z"],
    { env },
  );
  const records = stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    if (xy[0] === "R" || xy[0] === "C") i++; // rename/copy: skip the "from" record
    const rel = rec.slice(3);
    if (xy !== "??" || !rel.endsWith("/")) continue;
    const found: string[] = [];
    await findEmbeddedRepos(dest, rel.slice(0, -1), found);
    for (const f of found) out.add(f);
  }
  if (out.size === 0) return [];
  // Drop paths .gitignore already covers: they cannot be added anyway, and
  // explicitly naming an ignored path in an :(exclude) pathspec makes some
  // git versions refuse the whole `add` ("paths are ignored"). Exit-code
  // check per path (-q): immune to quote-mangling of unicode names.
  const kept: string[] = [];
  for (const c of out) {
    const isIgnored = await exec("git", ["-C", dest, "check-ignore", "-q", "--", c], { env })
      .then(() => true)
      .catch(() => false); // exit 1 = not ignored; other failures -> keep the exclude
    if (!isIgnored) kept.push(c);
  }
  return kept;
}

/** Bare gitlinks (mode 160000) in the index that are NOT declared submodules -
 *  either freshly staged by an `add`, or committed long ago (the historical
 *  corruption) and inherited by every clone since. */
export async function nonSubmoduleGitlinks(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["-C", dest, "ls-files", "--cached", "-s", "-z"],
    { env },
  );
  const links: string[] = [];
  for (const rec of stdout.split("\0")) {
    if (!rec.startsWith("160000 ")) continue;
    const tab = rec.indexOf("\t");
    if (tab !== -1) links.push(rec.slice(tab + 1));
  }
  if (links.length === 0) return [];
  const declared = await exec(
    "git",
    ["-C", dest, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { env },
  )
    .then(
      (r) =>
        new Set(
          r.stdout
            .split("\n")
            .map((l) => l.split(" ").slice(1).join(" "))
            .filter(Boolean),
        ),
    )
    .catch(() => new Set<string>());
  return links.filter((l) => !declared.has(l));
}

/** Unstage any bare gitlink (mode 160000) that is not a declared submodule.
 *  This is the belt to embeddedRepoExcludes' suspenders: whatever path slipped
 *  through (a repo inside an already-tracked dir, an exotic name), the commit
 *  never records a gitlink - the dir stays on disk, just untracked here. */
export async function dropStagedGitlinks(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const drop = await nonSubmoduleGitlinks(dest, env);
  if (drop.length === 0) return;
  await exec(
    "git",
    ["-C", dest, "rm", "-r", "--cached", "-f", "-q", "--", ...drop],
    { env },
  ).catch(() => {});
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
  nestedMounts: string[] = [],
): Promise<EntryOutcome> {
  const dest = path.join(workspace, mountPath);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Push with the connector's token as an inline auth header - the same way
  // `sync` and `collapse` authenticate. A bare `git push` here would instead
  // depend on the on-disk credential-store file, which is empty until a `sync`
  // populates it; that made `save` commit fine but fail to push (no terminal
  // prompt) on a freshly-set-up or never-synced machine.
  const auth = token ? gitAuthArgs(token) : [];

  // A detached HEAD cannot be saved: the commit would land on no branch (and
  // never push), yet read as a success. Refuse before touching anything.
  const onBranch = await exec("git", ["-C", dest, "symbolic-ref", "-q", "HEAD"], { env })
    .then(() => true)
    .catch(() => false);
  if (!onBranch) {
    throw new Error(
      "not on a branch (detached HEAD) - check out a branch (usually main) and re-run",
    );
  }

  // A fossilized stale token in .git/config would make the push 401 even
  // with a valid live token (two Authorization headers, server reads the
  // stale one).
  await dropStaleAuthHeader(dest, env);

  // A previous save/sync left a merge conflict here. While the markers are
  // still in the files the user has not resolved: re-report the conflict and
  // never commit - `git add -A` would complete the merge with the <<<<<<<
  // markers as content and push them to every machine. Once the files are
  // marker-free, the commit below completes the merge the way git intends.
  const unmerged = await conflictedFiles(dest, env);
  if (unmerged.length > 0) {
    const unresolved: string[] = [];
    for (const f of unmerged) {
      const txt = await readFile(path.join(dest, f), "utf8").catch(() => "");
      if (/^<{7}( |$)/m.test(txt) && /^>{7}( |$)/m.test(txt)) unresolved.push(f);
    }
    if (unresolved.length > 0) {
      return { action: "clean", conflictFiles: unresolved };
    }
  }

  // Ensure every nested mount is CARVED OUT of this folder (the ingest /
  // applyCreate convention): a `.gitignore` line per child, so plain `git
  // status` reads clean for users too and a fresh clone is born quiet. The
  // edit lands as a normal change this same save commits and pushes -
  // convergent across machines.
  for (const rel of nestedMounts) {
    const ignored = await exec("git", ["-C", dest, "check-ignore", "-q", "--", rel], { env })
      .then(() => true)
      .catch(() => false);
    if (!ignored) await carveOutFromParent(workspace, mountPath, rel);
  }

  const excludes = await embeddedRepoExcludes(dest, env, nestedMounts);
  const spec =
    excludes.length > 0
      ? ["--", ".", ...excludes.map((e) => `:(exclude,literal)${e}`)]
      : [];

  const { stdout: status } = await exec(
    "git",
    ["-C", dest, "status", "--porcelain", ...spec],
    { env },
  );
  // A merge left in progress (by a previous sync/save) whose only remaining
  // entries are excluded paths - e.g. an AA gitlink conflict on a nested
  // mount - leaves the filtered status EMPTY, yet the merge still must be
  // concluded or every future pull/push fails. If MERGE_HEAD exists and no
  // marker-unresolved file remains (checked above), commit regardless.
  const merging = await exec(
    "git",
    ["-C", dest, "rev-parse", "-q", "--verify", "MERGE_HEAD"],
    { env },
  )
    .then(() => true)
    .catch(() => false);
  // COMMITTED gitlinks (the historical corruption, inherited by every clone)
  // hide behind the excluded paths: the filtered status reads clean, so the
  // commit phase would never run and the tree never heals. If the index holds
  // any non-submodule gitlink, run the commit phase - dropStagedGitlinks
  // removes it and the push cleanses the tree for every machine.
  const staleGitlinks =
    (await nonSubmoduleGitlinks(dest, env)).length > 0;
  const ident = await identityArgs(dest, env);
  let committed = false;
  if (status.trim() !== "" || merging || staleGitlinks) {
    await exec("git", ["-C", dest, "add", "-A", ...spec], { env });
    await dropStagedGitlinks(dest, env);
    // --no-verify: a user-installed pre-commit hook must not block (or mutate)
    // a brain save - this is an abstraction over git, not a dev workflow.
    committed = await exec(
      "git",
      [...ident, "-C", dest, "commit", "--no-verify", "-m", message],
      { env },
    )
      .then(() => true)
      .catch(async (e) => {
        // Everything that was dirty got excluded/unstaged (e.g. only an
        // embedded repo changed): an empty index is "clean", not an error.
        const emptyIndex = await exec(
          "git",
          ["-C", dest, "diff", "--cached", "--quiet"],
          { env },
        )
          .then(() => true)
          .catch(() => false);
        if (emptyIndex) return false;
        throw e;
      });
  }

  const { upstream, ahead } = await aheadInfo(dest, env);
  if (ahead > 0) {
    if (!upstream) {
      // Unpushed work but no tracking ref (the user branched, or tracking was
      // lost). Push the branch under its own name so the work lands on the
      // server instead of silently staying local; no origin at all is an
      // honest error, not a fake "saved".
      await exec("git", ["-C", dest, "remote", "get-url", "origin"], { env }).catch(
        () => {
          throw new Error("no origin remote - run `monora sync` to wire this folder");
        },
      );
      await exec("git", [...auth, "-C", dest, "push", "-u", "origin", "HEAD"], { env });
      return { action: committed ? "saved" : "pushed" };
    }
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
  /** Rel paths of OTHER pending creates nested inside this one: they become
   *  their own repos in this same run and must not be swallowed as content. */
  nestedPending: string[] = [],
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
  }
  // Always point origin at the folder's own repo. The staged dir may already
  // be a repo with an `origin` of its own (a clone the user dropped in, or a
  // half-done earlier create) - pushing brain content to THAT origin would
  // leak it to an unrelated remote.
  await exec("git", ["-C", dest, "remote", "add", "origin", created.cloneUrl], {
    env,
  }).catch(() =>
    exec("git", ["-C", dest, "remote", "set-url", "origin", created.cloneUrl], { env }),
  );
  const spec =
    nestedPending.length > 0
      ? ["--", ".", ...nestedPending.map((e) => `:(exclude,literal)${e}`)]
      : [];
  await exec("git", ["-C", dest, "add", "-A", ...spec], { env });
  await dropStagedGitlinks(dest, env);
  // --allow-empty: an empty staged dir still needs a root commit, or the push
  // below has no HEAD to send (the create fails) and the folder never gets an
  // upstream, stranding everything added to it later.
  await exec(
    "git",
    [...ident, "-C", dest, "commit", "--no-verify", "--allow-empty", "-m", `Create ${create.mountPath}`],
    { env },
  ).catch(() => {});
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
  return withWorkspaceLock(opts.workspace, "save", () => doSave(opts, meta));
}

async function doSave(opts: SaveOptions, meta: WorkspaceMeta): Promise<SaveResult> {
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
    // The server manifest only feeds the D pass. If the route is down, record
    // it and skip deletions this run - committing and pushing local work (the
    // M pass) must not be hostage to the lifecycle API.
    const server = await fetchServerManifest(opts.baseUrl!, opts.token!).catch(
      (e) => {
        result.errors.push({
          mountPath: "(server)",
          error: `could not read the server manifest, deletions skipped this run: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
        return null;
      },
    );
    if (server) {
      const localByRepo = new Map(meta.entries.map((e) => [e.repoName, e.mountPath]));
      for (const e of server) {
        const localMount = localByRepo.get(e.repoName);
        if (!localMount) continue; // not something we have on disk
        deleteTotal++;
        if (!(await exists(path.join(opts.workspace, localMount)))) {
          dCandidates.push({ mountPath: localMount, folderId: e.folderId });
        }
      }
    }
  }
  const guardTrips =
    !opts.force && deleteGuardTrips(dCandidates.length, deleteTotal);
  const deletes = guardTrips ? [] : dCandidates;
  if (guardTrips) result.guarded = dCandidates.map((e) => e.mountPath);

  if (opts.dryRun) {
    // The M side of the plan: folders with anything to commit or push.
    const changed: string[] = [];
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const entry of meta.entries) {
      const dest = path.join(opts.workspace, entry.mountPath);
      if (!(await exists(path.join(dest, ".git")))) continue;
      if (await hasPendingWork(dest, env)) changed.push(entry.mountPath);
    }
    result.plan = {
      create: pending.creates.map((c) => c.mountPath),
      delete: deletes.map((e) => e.mountPath),
      changed,
    };
    return result;
  }

  // A first: creating a folder may carve a path out of its parent (a .gitignore
  // edit), which the M pass below then commits + pushes in the same run.
  if (canReconcile && pending.creates.length > 0) {
    // Parents before children: a child applied first would have nothing to be
    // carved out of, and the parent's add would then swallow it.
    const ordered = [...pending.creates].sort(
      (a, b) => a.mountPath.split("/").length - b.mountPath.split("/").length,
    );
    const remaining: PendingCreate[] = [];
    for (const create of ordered) {
      const nestedPending = ordered
        .filter((c) => c.mountPath.startsWith(`${create.mountPath}/`))
        .map((c) => c.mountPath.slice(create.mountPath.length + 1));
      try {
        await applyCreate(opts.workspace, create, opts.baseUrl!, opts.token!, nestedPending);
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
  const allMounts = meta.entries.map((e) => e.mountPath);
  await runPool(meta.entries, opts.concurrency ?? 8, async (entry) => {
    const dest = path.join(opts.workspace, entry.mountPath);
    if (!(await exists(path.join(dest, ".git")))) {
      // A missing DIRECTORY is the D case (handled below, silently here). A
      // directory that exists without a repo is a broken mount - say so, or
      // the folder reads as saved while it never saves.
      if (await exists(dest)) {
        result.errors.push({
          mountPath: entry.mountPath,
          error: "the folder is here but is not a git repo - run `monora sync` to remount it",
        });
      }
      return;
    }
    // Mounted folders nested INSIDE this one save through their own entry;
    // this folder must never commit them (see embeddedRepoExcludes).
    const nested = allMounts
      .filter((m) => m !== entry.mountPath && m.startsWith(`${entry.mountPath}/`))
      .map((m) => m.slice(entry.mountPath.length + 1));
    try {
      const outcome = await saveEntry(entry.mountPath, opts.workspace, message, opts.token, nested);
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
