import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Manifest, MountEntry } from "@monora/core";
import { reconcileRemovals } from "../sync";

const exec = promisify(execFile);
const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** A clean, committed git working tree at `<ws>/<mountPath>`. */
async function mountCleanFolder(ws: string, mountPath: string): Promise<void> {
  const dir = path.join(ws, mountPath);
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-b", "main", dir]);
  await writeFile(path.join(dir, "readme.md"), `# ${mountPath}\n`);
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [...IDENT, "-C", dir, "commit", "-m", "seed"]);
}

/** A clean working tree whose history is fully pushed to a local bare remote -
 *  what a synced folder really looks like. (A remoteless repo now reads as
 *  "unpushed commits" and is protected from the prune.) */
async function mountPushedFolder(ws: string, mountPath: string): Promise<void> {
  const bare = path.join(ws, ".bares", `${mountPath.replace(/\//g, "-")}.git`);
  await mkdir(path.dirname(bare), { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  const dir = path.join(ws, mountPath);
  await mkdir(path.dirname(dir), { recursive: true });
  await exec("git", ["clone", bare, dir]);
  await writeFile(path.join(dir, "readme.md"), `# ${mountPath}\n`);
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [...IDENT, "-C", dir, "commit", "-m", "seed"]);
  await exec("git", ["-C", dir, "push", "-u", "origin", "main"]);
}

interface MetaEntry {
  mountPath: string;
  repoName: string;
  folderId: string;
  orgId?: string;
}

async function writeMeta(ws: string, orgId: string, entries: MetaEntry[]): Promise<void> {
  await mkdir(path.join(ws, ".monora"), { recursive: true });
  await writeFile(
    path.join(ws, ".monora", "manifest.json"),
    JSON.stringify({ orgId, entries }, null, 2),
  );
}

function entry(mountPath: string, orgId: string): MountEntry {
  return {
    folderId: `f-${mountPath}`,
    repoName: `${orgId}/${mountPath}.git`,
    mountPath,
    cloneUrl: `https://git.test/${orgId}/${mountPath}.git`,
    permission: "read",
    orgId,
  };
}

function manifest(orgId: string, entries: MountEntry[]): Manifest {
  return { orgId, subjectId: "u1", entries };
}

function emptyResult() {
  return {
    mounted: [],
    removed: [] as string[],
    conflicts: [],
    errors: [] as { mountPath: string; error: string }[],
    metrics: {
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
      manifestEntries: 0,
      mounted: 0,
      removed: 0,
      conflicts: 0,
      errors: 0,
    },
  };
}

describe("reconcileRemovals - prune is scoped to the synced token's orgs", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), "monora-reconcile-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("does NOT prune another org's brain when the token only spans one org", async () => {
    // A workspace holding two brains: dreamshot (org A) and monora (org B),
    // both recorded by a prior cross-org sync.
    await mountCleanFolder(ws, "dreamshot/skills");
    await mountCleanFolder(ws, "monora/product-development");
    await writeMeta(ws, "orgA", [
      { mountPath: "dreamshot/skills", repoName: "orgA/skills.git", folderId: "f1", orgId: "orgA" },
      { mountPath: "monora/product-development", repoName: "orgB/pd.git", folderId: "f2", orgId: "orgB" },
    ]);

    // Now sync with an org-A-only token: the manifest lists only dreamshot.
    const result = emptyResult();
    await reconcileRemovals(ws, manifest("orgA", [entry("dreamshot/skills", "orgA")]), result);

    // monora must survive - it is out of scope, not revoked.
    expect(await exists(path.join(ws, "monora/product-development"))).toBe(true);
    expect(result.removed).not.toContain("monora/product-development");
    expect(result.removed).toEqual([]);
  });

  it("DOES prune a genuinely revoked folder within a covered org", async () => {
    await mountCleanFolder(ws, "dreamshot/skills");
    await mountPushedFolder(ws, "dreamshot/secrets");
    await writeMeta(ws, "orgA", [
      { mountPath: "dreamshot/skills", repoName: "orgA/skills.git", folderId: "f1", orgId: "orgA" },
      { mountPath: "dreamshot/secrets", repoName: "orgA/secrets.git", folderId: "f2", orgId: "orgA" },
    ]);

    // Sync with the org-A token, but access to `secrets` was revoked: it drops
    // out of the manifest while its org stays present via `skills`.
    const result = emptyResult();
    await reconcileRemovals(ws, manifest("orgA", [entry("dreamshot/skills", "orgA")]), result);

    expect(await exists(path.join(ws, "dreamshot/secrets"))).toBe(false);
    expect(result.removed).toEqual(["dreamshot/secrets"]);
  });

  it("never deletes a revoked folder that has uncommitted work", async () => {
    await mountCleanFolder(ws, "dreamshot/skills");
    await mountCleanFolder(ws, "dreamshot/secrets");
    await writeFile(path.join(ws, "dreamshot/secrets/draft.md"), "unsaved\n");
    await writeMeta(ws, "orgA", [
      { mountPath: "dreamshot/skills", repoName: "orgA/skills.git", folderId: "f1", orgId: "orgA" },
      { mountPath: "dreamshot/secrets", repoName: "orgA/secrets.git", folderId: "f2", orgId: "orgA" },
    ]);

    const result = emptyResult();
    await reconcileRemovals(ws, manifest("orgA", [entry("dreamshot/skills", "orgA")]), result);

    expect(await exists(path.join(ws, "dreamshot/secrets"))).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.errors[0]?.mountPath).toBe("dreamshot/secrets");
  });

  it("skips the prune entirely for legacy meta lacking per-entry orgId", async () => {
    await mountCleanFolder(ws, "dreamshot/skills");
    await mountCleanFolder(ws, "monora/product-development");
    // Pre-fix meta: no orgId on entries.
    await writeMeta(ws, "orgA", [
      { mountPath: "dreamshot/skills", repoName: "orgA/skills.git", folderId: "f1" },
      { mountPath: "monora/product-development", repoName: "orgB/pd.git", folderId: "f2" },
    ]);

    const result = emptyResult();
    await reconcileRemovals(ws, manifest("orgA", [entry("dreamshot/skills", "orgA")]), result);

    // Both survive: a legacy meta can't be scoped, so prune is deferred.
    expect(await exists(path.join(ws, "monora/product-development"))).toBe(true);
    expect(await exists(path.join(ws, "dreamshot/skills"))).toBe(true);
    expect(result.removed).toEqual([]);
  });
});
