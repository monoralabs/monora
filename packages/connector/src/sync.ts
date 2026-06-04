import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, access, rm, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Manifest, MountEntry } from "@monora/core";
import { defaultConfigPath } from "./config";

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
  errors: { mountPath: string; error: string }[];
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

async function syncEntry(
  entry: MountEntry,
  workspace: string,
  token: string,
  credFile: string | null,
): Promise<"cloned" | "pulled"> {
  const dest = path.join(workspace, entry.mountPath);
  const auth = gitAuthArgs(token);
  let action: "cloned" | "pulled";
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (await exists(path.join(dest, ".git"))) {
    // Skip the pull on an empty repo (unborn HEAD, e.g. a root folder with no
    // content yet): `git pull --ff-only` errors with "no such ref" otherwise.
    const hasHead = await exec("git", ["-C", dest, "rev-parse", "--verify", "--quiet", "HEAD"], { env })
      .then(() => true)
      .catch(() => false);
    if (hasHead) {
      await exec("git", [...auth, "-C", dest, "pull", "--ff-only"], { env });
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
  return action;
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
  const manifest = await fetchManifest(opts.baseUrl, opts.token);
  await mkdir(opts.workspace, { recursive: true });
  const credFile = await setupPushCredentials(opts.baseUrl, opts.token);

  const result: SyncResult = { mounted: [], removed: [], errors: [] };

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
        const action = await syncEntry(entry, opts.workspace, opts.token, credFile);
        result.mounted.push({ mountPath: entry.mountPath, action });
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

/** Remove mounts no longer authorized, but never destroy uncommitted work. */
async function reconcileRemovals(
  workspace: string,
  manifest: Manifest,
  result: SyncResult,
): Promise<void> {
  const meta = await readWorkspaceMeta(workspace);
  if (!meta) return;
  const current = new Set(manifest.entries.map((e) => e.mountPath));
  for (const prev of meta.entries.map((e) => e.mountPath)) {
    if (current.has(prev)) continue;
    const dest = path.join(workspace, prev);
    if (!(await exists(dest))) continue;
    try {
      const { stdout } = await exec("git", ["-C", dest, "status", "--porcelain"]);
      if (stdout.trim() !== "") {
        result.errors.push({
          mountPath: prev,
          error: "access revoked but the folder has uncommitted changes; left in place",
        });
        continue;
      }
      await rm(dest, { recursive: true, force: true });
      result.removed.push(prev);
    } catch {
      // Not a clean git dir; leave it alone.
    }
  }
}

interface WorkspaceMeta {
  orgId: string;
  entries: { mountPath: string; repoName: string; folderId: string }[];
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
