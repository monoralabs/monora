import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, access, rm, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Manifest, MountEntry } from "@monora/core";
import { defaultConfigPath } from "./config";
import { mergeUpstream } from "./git-integrate";

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
 *  the cloned repo's .git/config. */
export function gitAuthArgs(token: string): string[] {
  return ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
}

async function fetchManifest(baseUrl: string, token: string): Promise<Manifest> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/manifest`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`manifest request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as Manifest;
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
  if (await exists(path.join(dest, ".git"))) {
    // Skip the pull on an empty repo (unborn HEAD, e.g. a root folder with no
    // content yet): the merge errors with "no such ref" otherwise.
    const hasHead = await exec("git", ["-C", dest, "rev-parse", "--verify", "--quiet", "HEAD"], { env })
      .then(() => true)
      .catch(() => false);
    if (hasHead) {
      // Integrate by merging (not --ff-only): a multi-writer brain diverges, and
      // the git answer is to merge, not to refuse or force. A real line-level
      // conflict is left in place and reported; the folder still ends up mounted.
      const merged = await mergeUpstream(dest, env, auth);
      if (!merged.ok) conflictFiles = merged.conflictFiles;
    }
    action = "pulled";
  } else {
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
        // Materialize tracked files in place - unless the repo is empty (an
        // unborn HEAD, e.g. a freshly-created root folder with no content yet),
        // where there is nothing to check out.
        const hasHead = await exec("git", ["-C", dest, "rev-parse", "--verify", "--quiet", "HEAD"], { env })
          .then(() => true)
          .catch(() => false);
        if (hasHead) {
          await exec("git", ["-C", dest, "checkout", "-f", "HEAD"], { env });
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
    await exec("git", ["-C", dest, "config", "credential.helper", `store --file=${credFile}`]);
    await exec("git", ["-C", dest, "config", "credential.useHttpPath", "false"]);
  }
  return { action, conflictFiles };
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
  await writeFile(credFile, `https://x-access-token:${token}@${u.host}\n`, {
    mode: 0o600,
  });
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
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const manifest = await fetchManifest(opts.baseUrl, opts.token);
  await mkdir(opts.workspace, { recursive: true });
  const credFile = await setupPushCredentials(opts.baseUrl, opts.token);

  const result: SyncResult = {
    mounted: [],
    removed: [],
    conflicts: [],
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
        const outcome = await syncEntry(entry, opts.workspace, opts.token, credFile);
        if (outcome.conflictFiles) {
          result.conflicts.push({
            mountPath: entry.mountPath,
            files: outcome.conflictFiles,
          });
        }
        result.mounted.push({ mountPath: entry.mountPath, action: outcome.action });
      } catch (e) {
        result.errors.push({
          mountPath: entry.mountPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  await reconcileRemovals(opts.workspace, manifest, result);
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
): Promise<void> {
  const meta = await readWorkspaceMeta(workspace);
  if (!meta) return;
  // Legacy meta predating per-entry orgId can't be scoped safely; skip the
  // prune this once. `writeWorkspaceMeta` then records orgId per entry, so the
  // next sync reconciles correctly. A delayed cleanup beats a mis-scoped delete.
  if (!meta.entries.every((e) => typeof e.orgId === "string")) return;
  const current = new Set(manifest.entries.map((e) => e.mountPath));
  const coveredOrgs = new Set(manifest.entries.map((e) => e.orgId));
  for (const prev of meta.entries) {
    if (current.has(prev.mountPath)) continue;
    // Out of this token's scope (a different org) -> not a revocation. Skip.
    if (!coveredOrgs.has(prev.orgId)) continue;
    const dest = path.join(workspace, prev.mountPath);
    if (!(await exists(dest))) continue;
    try {
      const { stdout } = await exec("git", ["-C", dest, "status", "--porcelain"]);
      if (stdout.trim() !== "") {
        result.errors.push({
          mountPath: prev.mountPath,
          error: "access revoked but the folder has uncommitted changes; left in place",
        });
        continue;
      }
      await rm(dest, { recursive: true, force: true });
      result.removed.push(prev.mountPath);
    } catch {
      // Not a clean git dir; leave it alone.
    }
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

  const lines = [
    "# Monora workspace",
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
    "- **See what changed locally:** `monora status`.",
    "",
    "Each folder commits and pushes independently - there is no single repo at",
    "the workspace root.",
    "",
    "## Brains & folders",
    "",
    ...folderLines,
  ];
  await writeFile(path.join(workspace, "CLAUDE.md"), lines.join("\n"));
}
