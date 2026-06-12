import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import {
  fetchServerManifest,
  archiveFolderRemote,
  readPending,
  writePending,
  type ServerEntry,
} from "./lifecycle";
import { gitAuthArgs, setupPushCredentials, isUnsafeMountPath, errorMessage, credentialHelperValue } from "./sync";
import { reportUnexpected } from "./telemetry";
import { mergeUpstream } from "./git-integrate";
import { dropStagedGitlinks, embeddedRepoExcludes } from "./save";
import { withWorkspaceLock } from "./lock";

const exec = promisify(execFile);

/**
 * `monora collapse <folder>` - re-granularize a folder DOWN: fold its nested
 * child folders back into it so the folder becomes one repo holding plain
 * subdirectories, and archive the now-redundant child repos server-side.
 *
 * This is the inverse of `monora add` (which splits a subdirectory OUT into its
 * own repo). It exists because a brain's on-disk layout can diverge from the
 * server's: the server may have split `skills` into `skills`, `skills/apollo`,
 * `skills/finance`... while locally it is one flat `skills` repo. Collapsing
 * makes the server match the flat layout.
 *
 * Order is chosen so nothing is lost even if it is interrupted:
 *   1. un-carve each child in the parent's `.gitignore` and demote its `.git`
 *      (the child's files become plain content of the parent),
 *   2. commit + push the parent (its repo now owns every child's content),
 *   3. only THEN archive the child folders (a soft, recoverable delete).
 * The content reaches the parent's repo before any child is archived; and
 * archive keeps the bare repo, so `monora restore` undoes step 3.
 */
export interface CollapseOptions {
  baseUrl: string;
  token: string;
  workspace: string;
  /** Mount path of the parent to collapse into, e.g. `dreamshot/skills`. */
  target: string;
  message?: string;
  dryRun?: boolean;
}

export interface CollapsePlan {
  parentMount: string;
  /** Child folders that are flat content locally and will be folded + archived,
   *  deepest first. */
  children: ServerEntry[];
  /** Child folders left untouched because they are their own repo locally
   *  (legitimately separate - collapsing them would be wrong). */
  skipped: ServerEntry[];
}

export interface CollapseResult {
  /** Set on a dry run: the plan, with nothing changed. */
  plan?: CollapsePlan;
  /** Children archived on the server. */
  archived: { mountPath: string }[];
  /** Children left as their own repo (mounted standalone locally). */
  skipped: { mountPath: string }[];
  /** Child subpaths un-carved (removed from the parent's `.gitignore`). */
  uncarved: string[];
  /** Staged `monora add` creates under the collapsed parent, dropped because
   *  applying them later would re-split what was just folded. */
  unstaged: string[];
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

/**
 * Pick the parent and the descendants mounted strictly under it. The parent is
 * the server entry whose mountPath equals `target`. Returned deepest-first so a
 * nested chain un-carves from the leaves up. Pure: takes the server's entries
 * and a predicate that says whether a child is flat content locally (and so
 * should be folded) vs its own repo (and so left alone).
 */
export function planCollapse(
  entries: ServerEntry[],
  target: string,
  isFlatLocally: (e: ServerEntry) => boolean,
): CollapsePlan {
  const parentMount = target.replace(/\/+$/, "");
  const prefix = `${parentMount}/`;
  const descendants = entries
    .filter((e) => e.mountPath.startsWith(prefix))
    .sort((a, b) => b.mountPath.split("/").length - a.mountPath.split("/").length);
  const children = descendants.filter(isFlatLocally);
  const skipped = descendants.filter((e) => !isFlatLocally(e));
  return { parentMount, children, skipped };
}

/** Inverse of `save`'s carveOutFromParent: drop the `/childRel/` line from the
 *  parent's `.gitignore` so the parent tracks that subtree again. Returns true
 *  if a line was removed. */
async function unCarve(
  workspace: string,
  parentMount: string,
  childRel: string,
): Promise<boolean> {
  const ignoreFile = path.join(workspace, parentMount, ".gitignore");
  let current = "";
  try {
    current = await readFile(ignoreFile, "utf8");
  } catch {
    return false; // no .gitignore -> nothing carved out
  }
  const line = `/${childRel}/`;
  const kept = current.split(/\r?\n/).filter((l) => l.trim() !== line);
  if (kept.length === current.split(/\r?\n/).length) return false; // not present
  await writeFile(ignoreFile, kept.join("\n"));
  return true;
}

export async function collapse(opts: CollapseOptions): Promise<CollapseResult> {
  return withWorkspaceLock(opts.workspace, "collapse", () => doCollapse(opts));
}

async function doCollapse(opts: CollapseOptions): Promise<CollapseResult> {
  const result: CollapseResult = { archived: [], skipped: [], uncarved: [], unstaged: [], errors: [] };
  const entries = await fetchServerManifest(opts.baseUrl, opts.token);

  const parent = entries.find(
    (e) => e.mountPath === opts.target.replace(/\/+$/, ""),
  );
  if (!parent) {
    throw new Error(
      `no folder mounted at "${opts.target}" (run \`monora status\` to see folder paths)`,
    );
  }
  // A child is "flat locally" - and so foldable - when it has no `.git` of its
  // own (its files are plain content of an ancestor). A child that IS its own
  // repo locally is legitimately separate and must be left alone, so the same
  // collapse can run on a parent that mixes both (e.g. `work` with one flat
  // `work/mtng` and several standalone project folders).
  const target = opts.target.replace(/\/+$/, "");
  const prefix = `${target}/`;
  const flat = new Set<string>();
  for (const e of entries) {
    if (!e.mountPath.startsWith(prefix)) continue;
    if (!(await exists(path.join(opts.workspace, e.mountPath, ".git")))) {
      flat.add(e.mountPath);
    }
  }
  const plan = planCollapse(entries, opts.target, (e) => flat.has(e.mountPath));
  result.skipped = plan.skipped.map((c) => ({ mountPath: c.mountPath }));
  if (plan.children.length === 0) {
    return opts.dryRun ? { ...result, plan } : result; // nothing flat to fold
  }
  if (opts.dryRun) {
    return { ...result, plan };
  }

  const parentDir = path.join(opts.workspace, plan.parentMount);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const auth = gitAuthArgs(opts.token);

  // The parent must be a mounted repo BEFORE anything is mutated: bailing
  // after the un-carve pass would leave its .gitignore half-edited for a run
  // that can never absorb the children.
  if (!(await exists(path.join(parentDir, ".git")))) {
    throw new Error(
      `parent "${plan.parentMount}" is not on disk as a repo; sync it first so its content can absorb the children`,
    );
  }

  // 1. Fold each child into the parent's working tree: un-carve its subpath so
  //    its files become plain content the parent will track. (Children that are
  //    their own repo locally were already routed to `skipped` - nothing here
  //    ever deletes a `.git`.)
  const foldable: ServerEntry[] = [];
  for (const child of plan.children) {
    // A server mount path must resolve inside the workspace - same guard as
    // sync. A hostile/buggy path here would otherwise reach unCarve's file IO.
    if (isUnsafeMountPath(child.mountPath)) {
      result.errors.push({
        mountPath: child.mountPath,
        error: "unsafe mount path in the server manifest (would resolve outside the workspace) - skipped",
      });
      continue;
    }
    const childRel = child.mountPath.slice(plan.parentMount.length + 1);
    try {
      if (await unCarve(opts.workspace, plan.parentMount, childRel)) {
        result.uncarved.push(child.mountPath);
      }
      foldable.push(child);
    } catch (e) {
      reportUnexpected(e, { command: "collapse", operation: "uncarve" });
      result.errors.push({
        mountPath: child.mountPath,
        error: errorMessage(e),
      });
    }
  }

  // 2. Commit + push the parent so its repo owns every child's content BEFORE
  //    any child is archived.
  const credFile = await setupPushCredentials(opts.baseUrl, opts.token);
  // Skipped children are their own repos and stay separate: exclude them (and
  // any repo the user cloned inside) from the parent's add, the same way save
  // does - `git add -A` would otherwise record them as broken gitlinks, or die
  // outright on an embedded repo with no commits.
  const skippedRels = plan.skipped
    .filter((s) => !isUnsafeMountPath(s.mountPath))
    .map((s) => s.mountPath.slice(plan.parentMount.length + 1));
  const excludes = await embeddedRepoExcludes(parentDir, env, skippedRels);
  const spec =
    excludes.length > 0
      ? ["--", ".", ...excludes.map((e) => `:(exclude,literal)${e}`)]
      : [];
  await exec("git", ["-C", parentDir, "add", "-A", ...spec], { env });
  // Belt to the suspenders: whatever still slipped into the index as a bare
  // gitlink must never be committed - it lands on every other machine as a
  // broken empty dir.
  await dropStagedGitlinks(parentDir, env);
  const message = opts.message?.trim() || `Collapse ${plan.children.length} folder(s) into ${plan.parentMount}`;
  // An empty commit (nothing changed because content was already tracked flat)
  // is fine to skip; the push below still ensures the server has it.
  await exec("git", ["-C", parentDir, "-c", "user.name=monora", "-c", "user.email=connector@monora.ai", "commit", "--no-verify", "-m", message], {
    env,
  }).catch(() => {});
  if (credFile) {
    await exec("git", ["-C", parentDir, "config", "credential.helper", credentialHelperValue(credFile)], { env });
    await exec("git", ["-C", parentDir, "config", "credential.useHttpPath", "false"], { env });
  }
  // Push, integrating a diverged remote the same way save does: merge, never
  // force. A failure here must NOT throw away the result - nothing has been
  // archived yet, the un-carve is committed locally, and a re-run (or a plain
  // `monora save`) completes the job. Report and stop instead.
  try {
    await exec("git", [...auth, "-C", parentDir, "push", "origin", "HEAD:main"], { env });
  } catch {
    try {
      const merged = await mergeUpstream(parentDir, env, auth);
      if (!merged.ok) {
        result.errors.push({
          mountPath: plan.parentMount,
          error: `the parent diverged with conflicts (${(merged.conflictFiles ?? []).join(", ")}); resolve, \`monora save\`, then re-run collapse - nothing was archived`,
        });
        return result;
      }
      await exec("git", [...auth, "-C", parentDir, "push", "origin", "HEAD:main"], { env });
    } catch (e) {
      reportUnexpected(e, { command: "collapse", operation: "pushParent" });
      result.errors.push({
        mountPath: plan.parentMount,
        error: `could not push the parent (${errorMessage(e)}); nothing was archived - re-run collapse once the push works`,
      });
      return result;
    }
  }

  // 2.5 Verify each child was actually ABSORBED by the parent's repo before
  //     archiving it: if the parent still ignores the subpath (a .gitignore
  //     variant unCarve does not recognize, an info/exclude rule...), archiving
  //     would silently drop the folder from the manifest while its files never
  //     reached any pushed repo.
  const absorbed: ServerEntry[] = [];
  for (const child of foldable) {
    const childRel = child.mountPath.slice(plan.parentMount.length + 1);
    const tracked = await exec("git", ["-C", parentDir, "ls-files", "--", childRel], { env })
      .then((r) => r.stdout.trim() !== "")
      .catch(() => false);
    const hasContent = await readdir(path.join(opts.workspace, child.mountPath))
      .then((names) => names.length > 0)
      .catch(() => false);
    if (!tracked && hasContent) {
      result.errors.push({
        mountPath: child.mountPath,
        error:
          "the parent did not absorb this folder (still ignored? check the parent's .gitignore and .git/info/exclude) - not archived",
      });
      continue;
    }
    absorbed.push(child);
  }

  // 3. Archive the absorbed children server-side (soft, recoverable). Their
  //    content now lives in the parent's pushed repo.
  for (const child of absorbed) {
    try {
      await archiveFolderRemote(opts.baseUrl, opts.token, child.folderId);
      result.archived.push({ mountPath: child.mountPath });
    } catch (e) {
      reportUnexpected(e, { command: "collapse", operation: "archiveChild" });
      result.errors.push({
        mountPath: child.mountPath,
        error: errorMessage(e),
      });
    }
  }

  // 4. Drop staged creates under the collapsed parent: applying them on the
  //    next save would re-split what was just folded.
  const pending = await readPending(opts.workspace);
  const prefix2 = `${plan.parentMount}/`;
  const kept = pending.creates.filter((c) => {
    const under = c.mountPath === plan.parentMount || c.mountPath.startsWith(prefix2);
    if (under) result.unstaged.push(c.mountPath);
    return !under;
  });
  if (result.unstaged.length > 0) {
    await writePending(opts.workspace, { creates: kept });
  }

  return result;
}
