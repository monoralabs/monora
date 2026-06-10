import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Manifest, MountEntry } from "@monora/core";
import { sync, reconcileRemovals } from "../sync";

const exec = promisify(execFile);
const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, ...args]);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Bare repo seeded with the given files on main. */
async function seededBare(
  root: string,
  name: string,
  files: Record<string, string> = { "readme.md": "# seed\n" },
): Promise<string> {
  const bare = path.join(root, "remote", `${name}.git`);
  await mkdir(path.dirname(bare), { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  const seed = path.join(root, `seed-${name.replace(/\//g, "-")}`);
  await exec("git", ["clone", bare, seed]);
  for (const [f, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(seed, f)), { recursive: true });
    await writeFile(path.join(seed, f), content);
  }
  await git(seed, "add", "-A");
  await exec("git", [...IDENT, "-C", seed, "commit", "-m", "seed"]);
  await git(seed, "push", "-u", "origin", "main");
  await rm(seed, { recursive: true, force: true });
  return bare;
}

function entry(mountPath: string, cloneUrl: string, orgId = "orgA"): MountEntry {
  return {
    folderId: `f-${mountPath}`,
    repoName: `${orgId}/${mountPath.replace(/\//g, "-")}.git`,
    mountPath,
    cloneUrl,
    permission: "write",
    orgId,
  };
}

function stubManifest(entries: MountEntry[], orgId = "orgA") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ orgId, subjectId: "u1", entries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

async function writeMeta(
  ws: string,
  entries: { mountPath: string; repoName: string; folderId: string; orgId: string }[],
) {
  await mkdir(path.join(ws, ".monora"), { recursive: true });
  await writeFile(
    path.join(ws, ".monora", "manifest.json"),
    JSON.stringify({ orgId: "orgA", entries }, null, 2),
  );
}

function metaEntry(mountPath: string, orgId = "orgA") {
  return {
    mountPath,
    repoName: `${orgId}/${mountPath.replace(/\//g, "-")}.git`,
    folderId: `f-${mountPath}`,
    orgId,
  };
}

const BASE = { baseUrl: "http://proxy.test", token: "t", writeMcpConfig: false };

describe("sync edge cases (P0: prune safety)", () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-sync-edges-"));
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("S1: never prunes a revoked folder with committed-but-unpushed work", async () => {
    const alphaBare = await seededBare(root, "alpha");
    const betaBare = await seededBare(root, "beta");
    await exec("git", ["clone", alphaBare, path.join(ws, "acme", "alpha")]);
    await exec("git", ["clone", betaBare, path.join(ws, "acme", "beta")]);
    // Committed locally, never pushed: the tree is CLEAN but the commit
    // exists nowhere else.
    const beta = path.join(ws, "acme", "beta");
    await writeFile(path.join(beta, "work.md"), "# precious\n");
    await git(beta, "add", "-A");
    await exec("git", [...IDENT, "-C", beta, "commit", "-m", "unpushed work"]);

    await writeMeta(ws, [metaEntry("acme/alpha"), metaEntry("acme/beta")]);
    // Access to beta is revoked: it drops out while its org stays covered.
    stubManifest([entry("acme/alpha", alphaBare)]);

    const res = await sync({ ...BASE, workspace: ws });

    expect(await exists(beta)).toBe(true);
    expect(await readFile(path.join(beta, "work.md"), "utf8")).toContain("precious");
    expect(res.removed).toEqual([]);
    expect(res.errors.some((e) => e.mountPath === "acme/beta" && /unpushed/i.test(e.error))).toBe(true);
  }, 30_000);

  it("S2: never prunes a revoked parent that contains an authorized child mount", async () => {
    const parentBare = await seededBare(root, "area", {
      "readme.md": "# area\n",
      ".gitignore": "/sub/\n",
    });
    const childBare = await seededBare(root, "sub");
    await exec("git", ["clone", parentBare, path.join(ws, "acme", "area")]);
    await exec("git", ["clone", childBare, path.join(ws, "acme", "area", "sub")]);
    // The child holds uncommitted work that an rm -rf of the parent would kill.
    await writeFile(path.join(ws, "acme", "area", "sub", "draft.md"), "# wip\n");

    await writeMeta(ws, [metaEntry("acme/area"), metaEntry("acme/area/sub")]);
    // The PARENT is revoked; the child stays authorized.
    stubManifest([entry("acme/area/sub", childBare)]);

    const res = await sync({ ...BASE, workspace: ws });

    expect(await exists(path.join(ws, "acme", "area"))).toBe(true);
    expect(await readFile(path.join(ws, "acme", "area", "sub", "draft.md"), "utf8")).toContain("wip");
    expect(res.removed).toEqual([]);
    expect(
      res.errors.some((e) => e.mountPath === "acme/area" && /authorized|contains/i.test(e.error)),
    ).toBe(true);
  }, 30_000);

  it("S4: a manifest mount path with .. cannot escape the workspace", async () => {
    const bare = await seededBare(root, "evil");
    stubManifest([entry("../escape", bare)]);

    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors.some((e) => /mount path/i.test(e.error))).toBe(true);
    // Nothing landed OUTSIDE the workspace.
    expect(await exists(path.join(root, "escape"))).toBe(false);
  }, 30_000);

  it("S4b: the prune ignores unsafe mount paths from a stale local index", async () => {
    // An attacker-shaped (or corrupted) local index pointing outside the
    // workspace must never be rm -rf'd by the prune pass.
    const victim = path.join(root, "victim");
    await mkdir(victim, { recursive: true });
    await exec("git", ["init", "-b", "main", victim]);
    await writeMeta(ws, [metaEntry("../victim"), metaEntry("acme/alpha")]);

    const result = {
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
    const alphaBare = await seededBare(root, "alpha2");
    await reconcileRemovals(
      ws,
      { orgId: "orgA", subjectId: "u1", entries: [entry("acme/alpha", alphaBare)] },
      result,
    );

    expect(await exists(victim)).toBe(true);
    expect(result.removed).toEqual([]);
  }, 30_000);
});

describe("sync edge cases (P0: graft never overwrites local files)", () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-sync-graft-"));
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("S3: remounting after a lost .git keeps local edits and restores missing files", async () => {
    const bare = await seededBare(root, "folder", {
      "readme.md": "# original\n",
      "notes.md": "# notes\n",
    });
    const dest = path.join(ws, "acme", "folder");
    await exec("git", ["clone", bare, dest]);
    // The .git is lost (the E8 state); the user edits a file and deletes another.
    await rm(path.join(dest, ".git"), { recursive: true, force: true });
    await writeFile(path.join(dest, "readme.md"), "# my local edit\n");
    await rm(path.join(dest, "notes.md"), { force: true });

    stubManifest([entry("acme/folder", bare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors).toHaveLength(0);
    expect(await exists(path.join(dest, ".git"))).toBe(true);
    // The edit SURVIVES the remount (the old checkout -f wiped it)...
    expect(await readFile(path.join(dest, "readme.md"), "utf8")).toContain("my local edit");
    // ...and shows as a local modification for the next save.
    const { stdout } = await git(dest, "status", "--porcelain");
    expect(stdout).toContain("readme.md");
    // The file missing from disk is materialized from the repo.
    expect(await readFile(path.join(dest, "notes.md"), "utf8")).toContain("notes");
  }, 30_000);

  it("S3b: a root repo still mounts over existing nested content (regression guard)", async () => {
    const rootBare = await seededBare(root, "brainroot", {
      "readme.md": "# root\n",
      ".gitignore": "/nested/\n",
    });
    const dest = path.join(ws, "acme");
    // The nested folder landed first (depth ordering puts the root later
    // only when both are in the manifest; here it pre-exists).
    await mkdir(path.join(dest, "nested"), { recursive: true });
    await writeFile(path.join(dest, "nested", "x.md"), "# nested content\n");

    stubManifest([entry("acme", rootBare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors).toHaveLength(0);
    // Root files materialize, nested content untouched.
    expect(await readFile(path.join(dest, "readme.md"), "utf8")).toContain("root");
    expect(await readFile(path.join(dest, "nested", "x.md"), "utf8")).toContain("nested content");
  }, 30_000);
});

describe("sync edge cases (P1: honest errors + user files)", () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-sync-p1-"));
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("S5: a folder on a detached HEAD errors clearly, others still sync", async () => {
    const alphaBare = await seededBare(root, "alpha");
    const betaBare = await seededBare(root, "beta");
    await exec("git", ["clone", alphaBare, path.join(ws, "acme", "alpha")]);
    await exec("git", ["clone", betaBare, path.join(ws, "acme", "beta")]);
    await git(path.join(ws, "acme", "beta"), "checkout", "--detach");

    stubManifest([entry("acme/alpha", alphaBare), entry("acme/beta", betaBare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.mounted.some((m) => m.mountPath === "acme/alpha")).toBe(true);
    const err = res.errors.find((e) => e.mountPath === "acme/beta");
    expect(err?.error).toMatch(/detached/i);
  }, 30_000);

  it("S6: a user-edited workspace CLAUDE.md survives the next sync", async () => {
    const bare = await seededBare(root, "alpha");
    stubManifest([entry("acme/alpha", bare)]);
    await sync({ ...BASE, workspace: ws });
    // First sync generates the orientation file...
    expect(await readFile(path.join(ws, "CLAUDE.md"), "utf8")).toContain("Monora workspace");

    // ...the user takes it over...
    await writeFile(path.join(ws, "CLAUDE.md"), "# my own notes\ndo not touch\n");
    await sync({ ...BASE, workspace: ws });

    expect(await readFile(path.join(ws, "CLAUDE.md"), "utf8")).toContain("do not touch");
  }, 30_000);

  it("S7: a FILE occupying a mount path is a clear per-folder error", async () => {
    const alphaBare = await seededBare(root, "alpha");
    const blockedBare = await seededBare(root, "blocked");
    await mkdir(path.join(ws, "acme"), { recursive: true });
    await writeFile(path.join(ws, "acme", "blocked"), "i am a file\n");

    stubManifest([entry("acme/alpha", alphaBare), entry("acme/blocked", blockedBare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.mounted.some((m) => m.mountPath === "acme/alpha")).toBe(true);
    const err = res.errors.find((e) => e.mountPath === "acme/blocked");
    expect(err?.error).toMatch(/file occupies/i);
    // The file is left alone.
    expect(await readFile(path.join(ws, "acme", "blocked"), "utf8")).toContain("i am a file");
  }, 30_000);

  it("S9: a fossilized stale Bearer header in .git/config is dropped by sync", async () => {
    // Old setups / machine-copied repos carry `http.extraheader` with a stale
    // token persisted in the repo config; git then sends TWO Authorization
    // headers and the proxy reads the stale one -> every pull/push 401s.
    const bare = await seededBare(root, "alpha");
    const dest = path.join(ws, "acme", "alpha");
    await exec("git", ["clone", bare, dest]);
    await git(dest, "config", "http.extraheader", "Authorization: Bearer mna_stale_token");

    stubManifest([entry("acme/alpha", bare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors).toHaveLength(0);
    const persisted = await git(dest, "config", "--local", "--get-all", "http.extraheader")
      .then((r) => r.stdout.trim())
      .catch(() => "");
    expect(persisted).toBe("");
  }, 30_000);

  it("S13: a parent and its nested child leaving together prune in ONE pass (gitlinked child)", async () => {
    // The real-world case: the parent's TREE still carries a committed gitlink
    // for the child (historical corruption). The old child-first prune deleted
    // the child, which made the parent read dirty ("D child") on dirt we
    // inflicted ourselves - blocking the parent forever. Candidates are now
    // checked BEFORE any deletion and parents subsume verified children.
    const childBare = await seededBare(root, "meetings");
    const { stdout: childSha } = await exec("git", ["ls-remote", childBare, "main"]);
    const sha = childSha.split("\t")[0]!.trim();

    const parentBare = path.join(root, "remote", "data.git");
    await mkdir(path.dirname(parentBare), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", parentBare]);
    const seed = path.join(root, "seed-data");
    await exec("git", ["clone", parentBare, seed]);
    await writeFile(path.join(seed, "readme.md"), "# data\n");
    await git(seed, "add", "-A");
    // The committed gitlink, pointing at the child's exact HEAD (clean state).
    await git(seed, "update-index", "--add", "--cacheinfo", `160000,${sha},meetings`);
    await exec("git", [...IDENT, "-C", seed, "commit", "-m", "seed with gitlink"]);
    await git(seed, "push", "-u", "origin", "main");
    await rm(seed, { recursive: true, force: true });

    await exec("git", ["clone", parentBare, path.join(ws, "acme", "data")]);
    await exec("git", ["clone", childBare, path.join(ws, "acme", "data", "meetings")]);
    const alphaBare = await seededBare(root, "alpha");
    await exec("git", ["clone", alphaBare, path.join(ws, "acme", "alpha")]);
    await writeMeta(ws, [
      metaEntry("acme/alpha"),
      metaEntry("acme/data"),
      metaEntry("acme/data/meetings"),
    ]);

    // Both data and its child leave; alpha keeps the org covered.
    stubManifest([entry("acme/alpha", alphaBare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors).toHaveLength(0);
    expect(res.removed.sort()).toEqual(["acme/data", "acme/data/meetings"]);
    expect(await exists(path.join(ws, "acme", "data"))).toBe(false);
  }, 30_000);

  it("S15: an un-carved nested mount does not block its parent's prune", async () => {
    // The parent never got a `.gitignore` carve-out for its child mount, so
    // plain status reads `?? child/`. That is the child's own repo, not
    // uncommitted work of the parent - both leave scope, both must prune.
    const parentBare = await seededBare(root, "area");
    const childBare = await seededBare(root, "sub");
    const alphaBare = await seededBare(root, "alpha");
    await exec("git", ["clone", parentBare, path.join(ws, "acme", "area")]);
    await exec("git", ["clone", childBare, path.join(ws, "acme", "area", "sub")]);
    await exec("git", ["clone", alphaBare, path.join(ws, "acme", "alpha")]);
    await writeMeta(ws, [
      metaEntry("acme/alpha"),
      metaEntry("acme/area"),
      metaEntry("acme/area/sub"),
    ]);

    stubManifest([entry("acme/alpha", alphaBare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors).toHaveLength(0);
    expect(res.removed.sort()).toEqual(["acme/area", "acme/area/sub"]);
    expect(await exists(path.join(ws, "acme", "area"))).toBe(false);
  }, 30_000);

  it("S14: empty intermediate dirs are cleaned up after a prune", async () => {
    // A qualified brain shell (`guide-x/`) whose ONLY mount is pruned must not
    // stay behind as an empty husk.
    const guideBare = await seededBare(root, "guide");
    const alphaBare = await seededBare(root, "alpha");
    await exec("git", ["clone", guideBare, path.join(ws, "guide-AFtHPn9C", "guide")]);
    await exec("git", ["clone", alphaBare, path.join(ws, "acme", "alpha")]);
    await writeMeta(ws, [metaEntry("acme/alpha"), metaEntry("guide-AFtHPn9C/guide")]);

    stubManifest([entry("acme/alpha", alphaBare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.removed).toContain("guide-AFtHPn9C/guide");
    expect(await exists(path.join(ws, "guide-AFtHPn9C"))).toBe(false);
    // The workspace itself and unrelated dirs are untouched.
    expect(await exists(path.join(ws, "acme", "alpha"))).toBe(true);
  }, 30_000);

  it("S10: stale temp clone dirs from a crashed run are swept on the next sync", async () => {
    const bare = await seededBare(root, "alpha");
    const dest = path.join(ws, "acme", "alpha");
    await exec("git", ["clone", bare, dest]);
    // What a SIGKILL mid-graft leaves behind.
    const stale = `${dest}.monora-clone-12345`;
    await mkdir(path.join(stale, ".git"), { recursive: true });
    await writeFile(path.join(stale, ".git", "junk"), "leftover\n");

    stubManifest([entry("acme/alpha", bare)]);
    const res = await sync({ ...BASE, workspace: ws });

    expect(res.errors).toHaveLength(0);
    expect(await exists(stale)).toBe(false);
  }, 30_000);

  it("S8: a non-JSON manifest response fails with a readable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<!doctype html><h1>login</h1>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    await expect(sync({ ...BASE, workspace: ws })).rejects.toThrow(/JSON|proxy/i);
  }, 30_000);
});
