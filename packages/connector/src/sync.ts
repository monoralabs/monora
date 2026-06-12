import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, access, rm, rmdir, readdir, rename, lstat } from "node:fs/promises";
import path from "node:path";
import type { Manifest, MountEntry } from "@monora/core";
import { defaultConfigPath } from "./config";
import { mergeUpstream } from "./git-integrate";
import { applyScope, readWorkspaceScope } from "./scope";
import { withWorkspaceLock } from "./lock";

const exec = promisify(execFile);

export interface SyncOptions {
  /** Proxy base URL, e.g. https://git.monora.ai */
  baseUrl: string;
  token: string;
  /** Local directory to compose the authorized folders into. */
  workspace: string;
  concurrency?: number;
  /**
   * Write a project-scoped `.mcp.json` at the workspace root wiring the
   * read-only Monora MCP server, so an MCP agent launched here gets fast
   * search/read for free alongside the git tree. Default true. The CLI exposes
   * `--no-mcp` to opt out.
   */
  writeMcpConfig?: boolean;
}

export interface SyncResult {
  mounted: { mountPath: string; action: "cloned" | "pulled" }[];
  removed: string[];
  /** Folders left with merge conflict markers after the remote diverged on the
   *  same lines - resolve and re-sync. Every other folder still synced. */
  conflicts: { mountPath: string; files: string[] }[];
  /** Read-only folders holding local commits that can never reach the server
   *  (the push side rejects them). Sync still merges incoming updates into
   *  them - nothing is lost - but the user must hear that this work lives
   *  only on this machine. */
  readOnlyAhead: { mountPath: string }[];
  errors: { mountPath: string; error: string }[];
  metrics: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    manifestEntries: number;
    mounted: number;
    removed: number;
    conflicts: number;
    errors: number;
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Pass the token per-invocation via a header so it is never persisted into
 *  the cloned repo's .git/config. The empty `credential.helper=` RESETS git's
 *  helper list for this invocation: when the server rejects the request
 *  anyway (read-only folder, revoked login), git must fail cleanly - never
 *  fall through to a system helper (Git Credential Manager pops a username/
 *  password dialog on Windows) that knows nothing about Monora. */
export function gitAuthArgs(token: string): string[] {
  return [
    "-c",
    `http.extraHeader=Authorization: Bearer ${token}`,
    "-c",
    "credential.helper=",
  ];
}

/** Error messages embed the failed command line - including the auth header.
 *  Every error that reaches a result (and so the user's terminal, logs, CI
 *  output) goes through here first. */
export function redactSecrets(message: string): string {
  return message.replace(/mna_[A-Za-z0-9_-]+/g, "mna_***");
}

/** The message of an unknown thrown value, with secrets redacted. */
export function errorMessage(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}

/** The per-repo credential helper: READ-ONLY. A plain `store --file=X` helper
 *  lets git ERASE the entry whenever any push/pull gets a 401 (`credential
 *  reject` -> file truncated to 0 bytes) - one denied repo then breaks auth
 *  for every other repo until the next sync (the domino observed in the
 *  wild). This wrapper answers `get` through credential-store's matching and
 *  silently ignores `store`/`erase`, so git can never empty the file. */
export function credentialHelperValue(credFile: string): string {
  return `!f() { test "$1" = get && git credential-store --file="${credFile}" get; :; }; f`;
}

async function fetchManifest(baseUrl: string, token: string): Promise<Manifest> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/manifest`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`manifest request failed: HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => {
    throw new Error(
      "the manifest response was not JSON - is this baseUrl a Monora proxy?",
    );
  });
  return body as Manifest;
}

/** A mount path comes from the server manifest (or a local index a previous
 *  sync wrote). It must always resolve INSIDE the workspace: a `..`, absolute,
 *  or empty segment would let a buggy or hostile manifest write - and the
 *  prune pass delete - outside the tree. */
export function isUnsafeMountPath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return true;
  return p
    .split("/")
    .some((seg) => seg === ".." || seg === "." || seg === "");
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        await worker(item);
      }
    }),
  );
}

interface SyncEntryOutcome {
  action: "cloned" | "pulled";
  /** Files left conflicted after a divergent merge (folder needs resolving). */
  conflictFiles?: string[];
  /** Read-only folder with local commits the server will never accept. */
  readOnlyAhead?: boolean;
}

/**
 * If `dest` sits inside another folder's git working tree and that ancestor
 * repo still *tracks* files at this subpath, the on-disk layout has diverged
 * from the server's: the server splits this folder into its own repo, but
 * locally it is still plain content owned by a parent (a flattened brain).
 * Grafting a child repo here and `checkout -f HEAD` would overwrite the
 * parent-owned files with the (possibly stale) child repo - silent data loss.
 *
 * Returns the offending ancestor's working-tree root when that collision
 * exists, else null. A properly carved-out parent (`.gitignore` excludes the
 * child path, so it tracks nothing there) returns null and syncs normally.
 */
export async function ancestorRepoTracking(
  dest: string,
  workspace: string,
): Promise<string | null> {
  const root = path.resolve(workspace);
  let dir = path.dirname(path.resolve(dest));
  while (dir.startsWith(root + path.sep) && dir !== root) {
    if (await exists(path.join(dir, ".git"))) {
      const rel = path.relative(dir, path.resolve(dest)).split(path.sep).join("/");
      const { stdout } = await exec("git", ["-C", dir, "ls-files", "--", rel]).catch(
        () => ({ stdout: "" }),
      );
      return stdout.trim() !== "" ? dir : null;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** Remove a FOSSILIZED auth header from the repo's local config. The connector
 *  passes its token per-invocation (`gitAuthArgs`) precisely so it is never
 *  persisted - but old setups / copied repos carry a stale
 *  `http.extraheader = Authorization: Bearer mna_...` in `.git/config`. Git
 *  then sends BOTH headers and the server reads the stale one: every pull and
 *  push 401s even though the live token is valid. Any persisted Monora bearer
 *  header is by definition stale - drop it. (Found in the wild on two
 *  machines, 2026-06-10.) */
export async function dropStaleAuthHeader(
  dest: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const persisted = await exec(
    "git",
    ["-C", dest, "config", "--local", "--get-all", "http.extraheader"],
    { env },
  )
    .then((r) => r.stdout)
    .catch(() => "");
  if (/Bearer mna_/i.test(persisted)) {
    await exec("git", ["-C", dest, "config", "--unset-all", "http.extraheader"], {
      env,
    }).catch(() => {});
  }
}

async function syncEntry(
  entry: MountEntry,
  workspace: string,
  token: string,
  credFile: string | null,
): Promise<SyncEntryOutcome> {
  const dest = path.join(workspace, entry.mountPath);
  const auth = gitAuthArgs(token);
  let action: "cloned" | "pulled";
  let conflictFiles: string[] | undefined;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // Clear temp clone dirs a CRASHED previous run left next to this mount
  // (`<dest>.monora-clone-<pid>`). Safe here: the workspace lock guarantees no
  // other run is mid-graft, and the pattern is scoped to this entry's name.
  const parentOfDest = path.dirname(dest);
  const destBase = path.basename(dest);
  for (const name of await readdir(parentOfDest).catch(() => [] as string[])) {
    if (name.startsWith(`${destBase}.monora-clone-`)) {
      await rm(path.join(parentOfDest, name), { recursive: true, force: true });
    }
  }
  if (await exists(path.join(dest, ".git"))) {
    await dropStaleAuthHeader(dest, env);
    // Skip the pull on an empty repo (unborn HEAD, e.g. a root folder with no
    // content yet): the merge errors with "no such ref" otherwise.
    const hasHead = await exec("git", ["-C", dest, "rev-parse", "--verify", "--quiet", "HEAD"], { env })
      .then(() => true)
      .catch(() => false);
    if (hasHead) {
      // A detached HEAD can't integrate (no branch to merge into): surface the
      // same clear error `save` gives instead of a raw git message.
      const onBranch = await exec("git", ["-C", dest, "symbolic-ref", "-q", "HEAD"], { env })
        .then(() => true)
        .catch(() => false);
      if (!onBranch) {
        throw new Error(
          "not on a branch (detached HEAD) - check out a branch (usually main) and re-run",
        );
      }
      // Integrate by merging (not --ff-only): a multi-writer brain diverges, and
      // the git answer is to merge, not to refuse or force. A real line-level
      // conflict is left in place and reported; the folder still ends up mounted.
      try {
        const merged = await mergeUpstream(dest, env, auth);
        if (!merged.ok) conflictFiles = merged.conflictFiles;
      } catch (e) {
        // git refused because UNSAVED local edits collide with what's coming
        // in. The refusal is the safety (nothing was touched); the raw git
        // text is not a next step - say what to do in product words.
        if (/would be overwritten by merge/i.test(errorMessage(e))) {
          throw new Error(
            "you have unsaved changes here that collide with updates coming in - nothing was touched. Save them (`monora save -m \"what changed\"`) or discard them, then run `monora sync` again",
          );
        }
        throw e;
      }
    }
    action = "pulled";
  } else {
    // The mount path may be occupied by a plain FILE - mkdir would die with a
    // raw ENOTDIR. Refuse clearly and leave the file alone.
    const st = await lstat(dest).catch(() => null);
    if (st && !st.isDirectory()) {
      throw new Error(
        "a file occupies this folder's mount path - move it aside and re-run `monora sync`",
      );
    }
    await mkdir(dest, { recursive: true });
    const occupants = (await readdir(dest)).filter((e) => e !== ".git");
    if (occupants.length === 0) {
      await exec("git", [...auth, "clone", entry.cloneUrl, dest], { env });
    } else {
      // The mount dir already holds content - typically a brain root folder
      // mounting over its already-cloned nested folders. `git clone` refuses a
      // non-empty target, so clone into a temp dir, graft its `.git`, and check
      // out in place. Tracked root files land; untracked nested folders (which
      // the root folder's .gitignore lists) are left alone.
      //
      // But if the content here is tracked by a *parent* folder's repo, the
      // server has split this into its own repo while the local layout has not
      // (a flattened brain). Grafting + checkout would overwrite the
      // parent-owned files. Refuse instead of clobbering: skip the folder and
      // surface it so the topology can be reconciled first.
      const ancestor = await ancestorRepoTracking(dest, workspace);
      if (ancestor) {
        throw new Error(
          `mount path is tracked by the parent folder "${path.relative(workspace, ancestor)}"; ` +
            `the local layout has diverged from the server's (this folder is a separate repo on ` +
            `the server but plain content of a parent here). Reconcile the topology before syncing - ` +
            `left untouched, no data overwritten.`,
        );
      }
      const tmp = `${dest}.monora-clone-${process.pid}`;
      await rm(tmp, { recursive: true, force: true });
      try {
        await exec("git", [...auth, "clone", entry.cloneUrl, tmp], { env });
        await rename(path.join(tmp, ".git"), path.join(dest, ".git"));
        // Materialize tracked files MISSING from disk - and never overwrite a
        // file that already exists. It may hold newer local work (a remount
        // after a lost .git, a restore landing on a re-created path); an
        // existing file that differs simply shows up as a local modification
        // for the next save to integrate. Skipped on an unborn HEAD (a
        // freshly-created folder with no content yet).
        const hasHead = await exec("git", ["-C", dest, "rev-parse", "--verify", "--quiet", "HEAD"], { env })
          .then(() => true)
          .catch(() => false);
        if (hasHead) {
          const { stdout } = await exec("git", ["-C", dest, "ls-files", "-z"], { env });
          const missing: string[] = [];
          for (const f of stdout.split("\0").filter(Boolean)) {
            if (!(await exists(path.join(dest, f)))) missing.push(f);
          }
          for (let i = 0; i < missing.length; i += 100) {
            await exec(
              "git",
              ["-C", dest, "checkout", "--", ...missing.slice(i, i + 100)],
              { env },
            );
          }
        }
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    action = "cloned";
  }
  // Wire transparent `git push`/`pull`: a credential helper scoped to the proxy
  // host, reading the token from the connector's creds file. Without this, a
  // user `git push` from inside the folder would prompt for username/password.
  if (credFile) {
    await exec("git", ["-C", dest, "config", "credential.helper", credentialHelperValue(credFile)]);
    await exec("git", ["-C", dest, "config", "credential.useHttpPath", "false"]);
  }
  // A read-only folder can accumulate local commits the server will never
  // accept (saves are rejected with 403). Sync keeps merging updates INTO
  // them - but the user must hear that this work lives only here.
  let readOnlyAhead = false;
  if (entry.permission === "read" && action === "pulled") {
    readOnlyAhead = await exec(
      "git",
      ["-C", dest, "rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      { env },
    )
      .then((r) => (Number(r.stdout.trim()) || 0) > 0)
      .catch(() => false); // unborn HEAD -> nothing local to report
  }
  return { action, conflictFiles, readOnlyAhead };
}

/**
 * Write a `git-credentials` file (the format `git credential-store` reads) so a
 * user's `git push` to the proxy authenticates with the stored token - no
 * prompt. Scoped to the proxy host. Only for real https remotes; skipped for
 * localhost / in-process testing (validate-brain.ts), which never pushes.
 */
export async function setupPushCredentials(
  baseUrl: string,
  token: string,
): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const dir = path.dirname(defaultConfigPath());
  await mkdir(dir, { recursive: true });
  const credFile = path.join(dir, "git-credentials");
  // Atomic: write a temp file and rename it over. A plain writeFile truncates
  // first, so a crash (or a concurrent sync in ANOTHER workspace - the file
  // is global) could leave it EMPTY and every user-level `git push` would
  // prompt for a username until the next sync.
  const tmp = path.join(dir, `.git-credentials.${process.pid}.tmp`);
  await writeFile(tmp, `https://x-access-token:${token}@${u.host}\n`, {
    mode: 0o600,
  });
  await rename(tmp, credFile);
  return credFile;
}

/**
 * Compose the principal's authorized folders into one local working tree. Pulls
 * the manifest (the single source of truth for "what may I see"), then clones
 * or fast-forwards each folder into its mount path - in parallel. Folders no
 * longer in the manifest (access revoked) are removed when their tree is clean.
 *
 * It is real git underneath, so `claude`/`codex` operate on the result natively.
 */
export async function sync(opts: SyncOptions): Promise<SyncResult> {
  await mkdir(opts.workspace, { recursive: true });
  return withWorkspaceLock(opts.workspace, "sync", () => doSync(opts));
}

async function doSync(opts: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  // The server manifest lists every folder the token can read. A workspace
  // scope (`.monora/workspace.json`) is a local choice to materialize only a
  // subset here - so we mount the filtered view but keep the full manifest to
  // tell the prune pass "out of scope" (still authorized, drop it) apart from
  // "out of this token's reach" (leave it alone).
  const fullManifest = await fetchManifest(opts.baseUrl, opts.token);
  const scope = await readWorkspaceScope(opts.workspace);
  const manifest = scope ? applyScope(fullManifest, scope) : fullManifest;
  await mkdir(opts.workspace, { recursive: true });
  const credFile = await setupPushCredentials(opts.baseUrl, opts.token);

  const result: SyncResult = {
    mounted: [],
    removed: [],
    conflicts: [],
    readOnlyAhead: [],
    errors: [],
    metrics: {
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      manifestEntries: manifest.entries.length,
      mounted: 0,
      removed: 0,
      conflicts: 0,
      errors: 0,
    },
  };

  // Clone ancestors before descendants: a nested folder (e.g. `data/contacts`)
  // mounts inside its parent's working tree, and `git clone` refuses a
  // non-empty destination - so the parent must land first. Group by mount-path
  // depth and clone each level in parallel behind a barrier.
  const byDepth = new Map<number, MountEntry[]>();
  for (const entry of manifest.entries) {
    const depth = entry.mountPath.split("/").length;
    const bucket = byDepth.get(depth);
    if (bucket) bucket.push(entry);
    else byDepth.set(depth, [entry]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    await runPool(byDepth.get(depth)!, opts.concurrency ?? 8, async (entry) => {
      try {
        if (isUnsafeMountPath(entry.mountPath)) {
          throw new Error(
            "unsafe mount path in the server manifest (would resolve outside the workspace) - skipped",
          );
        }
        const outcome = await syncEntry(entry, opts.workspace, opts.token, credFile);
        if (outcome.conflictFiles) {
          result.conflicts.push({
            mountPath: entry.mountPath,
            files: outcome.conflictFiles,
          });
        }
        if (outcome.readOnlyAhead) {
          result.readOnlyAhead.push({ mountPath: entry.mountPath });
        }
        result.mounted.push({ mountPath: entry.mountPath, action: outcome.action });
      } catch (e) {
        result.errors.push({
          mountPath: entry.mountPath,
          error: errorMessage(e),
        });
      }
    });
  }

  await reconcileRemovals(opts.workspace, manifest, result, fullManifest);
  await writeWorkspaceMeta(opts.workspace, manifest);
  if (opts.writeMcpConfig !== false) await writeMcpConfig(opts.workspace);
  const finished = Date.now();
  result.metrics = {
    ...result.metrics,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    mounted: result.mounted.length,
    removed: result.removed.length,
    conflicts: result.conflicts.length,
    errors: result.errors.length,
  };
  return result;
}

/**
 * Drop a project-scoped `.mcp.json` at the workspace root so an MCP agent
 * (Claude Code / Codex / Cursor) launched here gets the read-only Monora server
 * for free - complementing the git read+write tree. Deliberately writes NO
 * token: `@monora-ai/mcp` reads it from the connector's credentials file (written
 * by `monora login`), so the secret stays in one 0600 file, never in the
 * workspace. Merges into an existing `.mcp.json`, owning only the `monora` key;
 * if the file exists but is unparseable, it is left untouched.
 */
export async function writeMcpConfig(workspace: string): Promise<void> {
  const file = path.join(workspace, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    const existing = await readFile(file, "utf8");
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object") {
      config = parsed as { mcpServers?: Record<string, unknown> };
    } else {
      return; // present but not an object; don't clobber
    }
  } catch (e) {
    // ENOENT -> create fresh. Any other read/parse failure -> leave it alone.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      try {
        await access(file);
        return; // exists but unparseable; don't clobber
      } catch {
        // truly absent; fall through and create
      }
    }
  }
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    monora: { command: "npx", args: ["-y", "@monora-ai/mcp"] },
  };
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Remove mounts no longer authorized, but never destroy uncommitted work - and
 * never delete a folder this sync simply could not see.
 *
 * A workspace can hold brains from several orgs (a user-scoped token composes
 * them into one tree, and people also keep more than one brain side by side).
 * A given sync, though, may run with a token that only spans *some* of those
 * orgs. The manifest then lists only the covered orgs' folders - the others are
 * absent not because access was revoked, but because they were out of this
 * token's scope. Pruning on "absent from the manifest" alone therefore deletes
 * a sibling brain's work whenever you sync with a narrower-scoped token (the
 * exact way an org-scoped sync once wiped a second org's brain).
 *
 * So removal is scoped to the orgs the current manifest actually covers. A
 * genuine per-folder revocation still prunes (the folder's org stays present
 * via its other folders); a folder belonging to an org this token doesn't span
 * is left untouched.
 */
export async function reconcileRemovals(
  workspace: string,
  manifest: Manifest,
  result: SyncResult,
  fullManifest: Manifest = manifest,
): Promise<void> {
  const meta = await readWorkspaceMeta(workspace);
  if (!meta) return;
  // Legacy meta predating per-entry orgId can't be scoped safely; skip the
  // prune this once. `writeWorkspaceMeta` then records orgId per entry, so the
  // next sync reconciles correctly. A delayed cleanup beats a mis-scoped delete.
  if (!meta.entries.every((e) => typeof e.orgId === "string")) return;
  const current = new Set(manifest.entries.map((e) => e.mountPath));
  // Org coverage comes from the FULL manifest: a folder hidden by a local
  // workspace scope is still authorized (its org is covered), so dropping it
  // here is a deliberate narrowing - unlike a folder whose org this token
  // cannot see at all, which must be left alone.
  const coveredOrgs = new Set(fullManifest.entries.map((e) => e.orgId));

  // Phase 1: the candidates - no disk mutations yet.
  const candidates: typeof meta.entries = [];
  for (const prev of meta.entries) {
    if (current.has(prev.mountPath)) continue;
    // Out of this token's scope (a different org) -> not a revocation. Skip.
    if (!coveredOrgs.has(prev.orgId)) continue;
    // A stale/corrupted index entry pointing outside the workspace must never
    // be rm -rf'd, wherever it came from.
    if (isUnsafeMountPath(prev.mountPath)) continue;
    if (!(await exists(path.join(workspace, prev.mountPath)))) continue;
    candidates.push(prev);
  }
  if (candidates.length === 0) return;

  // Phase 2: safety-check EVERY candidate against the disk as it is NOW,
  // before anything is removed. (Removing a child first would make a parent
  // whose tree references it read dirty - "D child" - and block the parent on
  // dirt we inflicted ourselves.) Empty reason = leave silently.
  const allKnownMounts = [
    ...new Set([...current, ...meta.entries.map((e) => e.mountPath)]),
  ];
  const blocked = new Map<string, string>();
  const demoted = new Set<string>();
  for (const prev of candidates) {
    const dest = path.join(workspace, prev.mountPath);
    // The folder left the manifest but a PARENT repo here tracks files at its
    // path: the server folded it into the parent (granular -> flat) while
    // this stale workspace still holds the old granular clone. rm -rf would
    // delete content the parent tracks - and the next save would commit those
    // deletions and push them. Demote instead: drop the clone's .git, keep
    // every file as the parent's flat content.
    if (await ancestorRepoTracking(dest, workspace)) {
      await rm(path.join(dest, ".git"), { recursive: true, force: true });
      demoted.add(prev.mountPath);
      result.removed.push(prev.mountPath);
      continue;
    }
    // Dirt is measured the way save measures it: nested mounts living inside
    // this folder are their own repos, not "uncommitted changes" of it (an
    // un-carved child shows as `?? child/` and would block forever).
    const prefix = `${prev.mountPath}/`;
    const nestedRels = allKnownMounts
      .filter((m) => m.startsWith(prefix))
      .map((m) => m.slice(prefix.length));
    const spec =
      nestedRels.length > 0
        ? ["--", ".", ...nestedRels.map((r) => `:(exclude,literal)${r}`)]
        : [];
    try {
      const { stdout } = await exec("git", ["-C", dest, "status", "--porcelain", ...spec]);
      if (stdout.trim() !== "") {
        blocked.set(prev.mountPath, "access revoked but the folder has uncommitted changes; left in place");
        continue;
      }
      // A clean tree can still hold COMMITS that exist on no remote - deleting
      // the folder would be the only copy gone. Count anything not reachable
      // from a remote-tracking ref before destroying.
      const unpushed = await exec(
        "git",
        ["-C", dest, "rev-list", "--count", "HEAD", "--not", "--remotes"],
      )
        .then((r) => Number(r.stdout.trim()) || 0)
        .catch(() => 0); // unborn HEAD -> nothing committed
      if (unpushed > 0) {
        blocked.set(prev.mountPath, "access revoked but the folder has unpushed commits; left in place");
      }
    } catch {
      blocked.set(prev.mountPath, ""); // not a clean git dir; leave it alone
    }
  }
  for (const [mountPath, reason] of blocked) {
    if (reason) result.errors.push({ mountPath, error: reason });
  }

  // Phase 3: a candidate that still contains a KEPT mount (still authorized
  // here, or blocked above) cannot go - deleting it would take that mount,
  // and its work, along.
  const kept = [...current, ...blocked.keys()];
  const removable = candidates.filter((c) => {
    if (demoted.has(c.mountPath)) return false; // already handled (kept as parent content)
    if (blocked.has(c.mountPath)) return false;
    const prefix = `${c.mountPath}/`;
    if (kept.some((m) => m.startsWith(prefix))) {
      result.errors.push({
        mountPath: c.mountPath,
        error:
          "no longer mounted here, but it still contains authorized folder(s); left in place",
      });
      return false;
    }
    return true;
  });

  // Phase 4: delete parents first - every descendant was already verified
  // clean above, so an ancestor's rm -rf safely subsumes it.
  removable.sort(
    (a, b) => a.mountPath.split("/").length - b.mountPath.split("/").length,
  );
  const deleted: string[] = [];
  for (const prev of removable) {
    const subsumed = deleted.some((p) => prev.mountPath.startsWith(`${p}/`));
    if (!subsumed) {
      await rm(path.join(workspace, prev.mountPath), { recursive: true, force: true });
      deleted.push(prev.mountPath);
      await removeEmptyParents(workspace, prev.mountPath);
    }
    result.removed.push(prev.mountPath);
  }
}

/** After a mount is pruned, intermediate dirs sync created for it (a brain
 *  slug dir, a qualified `<slug>-<org8>` shell) may be left empty - climb
 *  toward the workspace root removing them. `rmdir` only ever removes EMPTY
 *  dirs, so user content is never at risk. */
async function removeEmptyParents(
  workspace: string,
  mountPath: string,
): Promise<void> {
  const root = path.resolve(workspace);
  let dir = path.dirname(path.resolve(root, mountPath));
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await rmdir(dir); // fails (ENOTEMPTY) the moment anything remains
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

interface WorkspaceMeta {
  orgId: string;
  entries: { mountPath: string; repoName: string; folderId: string; orgId: string }[];
}

function metaPath(workspace: string): string {
  return path.join(workspace, ".monora", "manifest.json");
}

async function readWorkspaceMeta(
  workspace: string,
): Promise<WorkspaceMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(workspace), "utf8")) as WorkspaceMeta;
  } catch {
    return null;
  }
}

async function writeWorkspaceMeta(
  workspace: string,
  manifest: Manifest,
): Promise<void> {
  await mkdir(path.join(workspace, ".monora"), { recursive: true });
  const meta: WorkspaceMeta = {
    orgId: manifest.orgId,
    entries: manifest.entries.map((e) => ({
      mountPath: e.mountPath,
      repoName: e.repoName,
      // Persisted so `monora save` can reconcile a deleted folder: the proxy
      // archive route is keyed by folder id, which is not derivable from disk.
      folderId: e.folderId,
      // Persisted so the next sync's removal pass can tell "access revoked"
      // from "out of this token's scope" and never prune another org's brain.
      orgId: e.orgId,
    })),
  };
  await writeFile(metaPath(workspace), JSON.stringify(meta, null, 2) + "\n");

  // An orientation file for coding agents dropped into the composed tree.
  // Group folders by brain (the first mount-path segment) so the layout reads
  // as one subtree per brain, mirroring how they are mounted on disk.
  const byBrain = new Map<string, MountEntry[]>();
  for (const e of manifest.entries) {
    const brain = e.mountPath.split("/")[0] ?? e.mountPath;
    const bucket = byBrain.get(brain);
    if (bucket) bucket.push(e);
    else byBrain.set(brain, [e]);
  }
  const folderLines: string[] = [];
  for (const brain of [...byBrain.keys()].sort()) {
    folderLines.push(`### ${brain}/`);
    for (const e of byBrain.get(brain)!.sort((a, b) => a.mountPath.localeCompare(b.mountPath))) {
      folderLines.push(`- \`${e.mountPath}/\` (${e.permission})`);
    }
    folderLines.push("");
  }

  // Sync owns this file ONLY while it carries the marker: a user who edits it
  // (removing the marker, or any legacy pre-marker copy) keeps their version -
  // we never clobber user-authored orientation notes.
  const claudePath = path.join(workspace, "CLAUDE.md");
  const existing = await readFile(claudePath, "utf8").catch(() => null);
  if (existing !== null && !existing.includes(CLAUDE_GENERATED_MARKER)) return;

  const lines = [
    "# Monora workspace",
    "",
    CLAUDE_GENERATED_MARKER,
    "",
    "This tree is composed from the folders you (or this agent's token) are",
    "authorized to read. Each top-level folder is a **brain** (a workspace /",
    "shared drive); inside it, every folder is its own git repo, mounted at",
    "`<brain>/<path>`. A folder you cannot read never appears here at all -",
    "authorization is enforced server-side, not by hiding files.",
    "",
    "## Operating this workspace",
    "",
    "- **Read:** just open the files. It is a normal directory tree.",
    "- **Search fast (no clone walk):** a read-only Monora MCP server is wired",
    "  in `.mcp.json` at this root, so an MCP agent can search/read across all",
    "  your authorized folders directly. It uses your `monora login` credentials.",
    "- **Edit + save back:** edit files in any folder you have `write`/`admin`",
    "  on, then run `monora save -m \"what changed\"` from this workspace root. It",
    "  commits and pushes every folder with changes in one step. Raw",
    "  `git add`/`commit`/`push` *from inside a folder* still works too - the",
    "  connector wired your token as a git credential helper, so push/pull need",
    "  no prompt. A `read`-only folder rejects pushes server-side.",
    "- **Pull one folder:** `git -C <brain>/<path> pull --ff-only`.",
    "- **Update everything / pick up newly shared folders:** run `monora sync`",
    "  from this workspace root. It fast-forwards each folder, clones ones newly",
    "  shared with you, and drops ones no longer shared (only when clean).",
    "- **Focus this workspace on a subset:** by default `sync` mounts every brain",
    "  you can read. To keep only some here, scope it: `monora sync --brains",
    "  <slug,...>` (or `--orgs <id,...>`). The choice is saved in",
    "  `.monora/workspace.json` and is sticky; out-of-scope folders are pruned",
    "  (clean checkouts only). `--unscope` brings everything back. Scope only",
    "  hides folders locally - it never changes what you are authorized for. See",
    "  `monora help scope`.",
    "- **See what changed locally:** `monora status`.",
    "- **Update this tool itself:** `monora update` brings the connector to the",
    "  latest release (safe to run any time; it only touches the CLI, never your",
    "  folders).",
    "- **If a `monora` command fails unexpectedly** (a crash or a raw git error,",
    "  not a normal \"no access\"/\"resolve the conflict\" message), that is a bug in",
    "  Monora - it is open source (https://github.com/monoralabs/monora). With",
    "  the user's OK you may report it (`gh issue create -R monoralabs/monora`),",
    "  ANONYMIZED: no keys, no org/brain/folder names, no private paths. Check",
    "  open issues first to avoid duplicates.",
    "",
    "Each folder commits and pushes independently - there is no single repo at",
    "the workspace root.",
    "",
    "## Brains & folders",
    "",
    ...folderLines,
  ];
  await writeFile(claudePath, lines.join("\n"));
}

/** Presence of this line means sync generated the file and may regenerate it.
 *  Removing the line hands the file to the user permanently. */
const CLAUDE_GENERATED_MARKER =
  "<!-- generated by `monora sync`; edits are overwritten - delete this line to take ownership -->";
