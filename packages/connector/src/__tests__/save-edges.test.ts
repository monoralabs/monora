import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { save } from "../save";
import { writePending, type PendingCreate } from "../lifecycle";

const exec = promisify(execFile);
const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, ...args]);
}

/** Bare repo seeded with one commit on main, so clones get an upstream. */
async function seededBare(root: string, name: string): Promise<string> {
  const bare = path.join(root, "remote", `${name}.git`);
  await mkdir(path.dirname(bare), { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  const seed = path.join(root, `seed-${name.replace(/\//g, "-")}`);
  await exec("git", ["clone", bare, seed]);
  await writeFile(path.join(seed, "readme.md"), "# seed\n");
  await git(seed, "add", "-A");
  await exec("git", [...IDENT, "-C", seed, "commit", "-m", "seed"]);
  await git(seed, "push", "-u", "origin", "main");
  await rm(seed, { recursive: true, force: true });
  return bare;
}

async function writeManifest(
  ws: string,
  entries: { mountPath: string; repoName: string; folderId: string }[],
) {
  await mkdir(path.join(ws, ".monora"), { recursive: true });
  await writeFile(
    path.join(ws, ".monora", "manifest.json"),
    JSON.stringify({ orgId: "org_edges", entries }),
  );
}

/** Fake proxy: manifest + archive + folder create. `createUrls` maps a staged
 *  slug to the cloneUrl the create route should hand back (a local bare repo).
 *  `manifestStatus` lets a test break the manifest route while keeping create
 *  alive. */
function fakeProxy(opts: {
  entries?: { folderId: string; repoName: string; mountPath: string }[];
  createUrls?: Record<string, string>;
  manifestStatus?: number;
}): Promise<{
  baseUrl: string;
  archived: string[];
  created: string[];
  close: () => void;
}> {
  const archived: string[] = [];
  const created: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/manifest") {
      if (opts.manifestStatus && opts.manifestStatus !== 200) {
        res.writeHead(opts.manifestStatus);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orgId: "org_edges", entries: opts.entries ?? [] }));
      return;
    }
    const arch = req.url?.match(/^\/folders\/([^/]+)\/archive$/);
    if (req.method === "POST" && arch) {
      archived.push(arch[1]!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ archived: [arch[1]] }));
      return;
    }
    const create = req.url?.match(/^\/brains\/([^/]+)\/folders$/);
    if (req.method === "POST" && create) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { slug } = JSON.parse(body) as { slug: string };
        const cloneUrl = opts.createUrls?.[slug];
        if (!cloneUrl) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `no create wired for ${slug}` }));
          return;
        }
        created.push(slug);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ folderId: `id-${slug}`, repoName: `b1/${slug}.git`, cloneUrl }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        archived,
        created,
        close: () => server.close(),
      });
    });
  });
}

describe("save edge cases (P0: corruption / loss)", () => {
  let root: string;
  let ws: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-edges-"));
    bare = await seededBare(root, "acme/folder");
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
    await exec("git", ["clone", bare, path.join(ws, "acme", "folder")]);
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Push a same-line edit from "another machine" so the next save conflicts. */
  async function makeConflict(): Promise<string> {
    const other = path.join(root, "other");
    await exec("git", ["clone", bare, other]);
    await writeFile(path.join(other, "readme.md"), "# seed\nremote wins\n");
    await git(other, "add", "-A");
    await exec("git", [...IDENT, "-C", other, "commit", "-m", "remote edit"]);
    await git(other, "push", "origin", "main");
    await rm(other, { recursive: true, force: true });
    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "readme.md"), "# seed\nlocal wins\n");
    return folder;
  }

  it("E1: re-saving an UNRESOLVED conflict never pushes the markers", async () => {
    const folder = await makeConflict();
    const first = await save({ workspace: ws, message: "local edit" });
    expect(first.conflicts).toEqual([{ mountPath: "acme/folder", files: ["readme.md"] }]);

    // An agent (or a hasty user) re-runs save WITHOUT touching the file.
    const second = await save({ workspace: ws, message: "retry" });

    // Still reported as the same conflict - not silently committed.
    expect(second.conflicts).toEqual([
      { mountPath: "acme/folder", files: ["readme.md"] },
    ]);
    expect(second.errors).toHaveLength(0);
    // And the remote NEVER receives conflict markers.
    const verify = path.join(root, "verify-e1");
    await exec("git", ["clone", bare, verify]);
    expect(await readFile(path.join(verify, "readme.md"), "utf8")).not.toContain("<<<<<<<");
    // Markers are still on disk for the user to resolve.
    expect(await readFile(path.join(folder, "readme.md"), "utf8")).toContain("<<<<<<<");
  }, 30_000);

  it("E1b: after the user RESOLVES the markers, re-save completes the merge and pushes", async () => {
    const folder = await makeConflict();
    await save({ workspace: ws, message: "local edit" });

    // The user resolves by hand (markers gone), then re-saves.
    await writeFile(path.join(folder, "readme.md"), "# seed\nboth win\n");
    const res = await save({ workspace: ws, message: "resolve" });

    expect(res.errors).toHaveLength(0);
    expect(res.conflicts).toHaveLength(0);
    const verify = path.join(root, "verify-e1b");
    await exec("git", ["clone", bare, verify]);
    expect(await readFile(path.join(verify, "readme.md"), "utf8")).toContain("both win");
  }, 30_000);

  it("E2: detached HEAD is a per-folder error, not a silent fake save", async () => {
    const folder = path.join(ws, "acme", "folder");
    await git(folder, "checkout", "--detach");
    await writeFile(path.join(folder, "stranded.md"), "# do not lose me\n");

    const res = await save({ workspace: ws, message: "detached" });

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.mountPath).toBe("acme/folder");
    expect(res.errors[0]!.error).toMatch(/branch/i);
    // Nothing was committed into the void: the edit is still in the working tree.
    const { stdout } = await git(folder, "status", "--porcelain");
    expect(stdout).toContain("stranded.md");
  }, 30_000);

  it("E3: a branch without upstream still lands on the server (push -u)", async () => {
    const folder = path.join(ws, "acme", "folder");
    await git(folder, "checkout", "-b", "scratch");
    await writeFile(path.join(folder, "branch-work.md"), "# on a branch\n");

    const res = await save({ workspace: ws, message: "branch work" });

    expect(res.errors).toHaveLength(0);
    expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "saved" }]);
    // The commit is on the remote (its own branch), not stranded locally.
    const { stdout } = await exec("git", [
      "-C", bare, "log", "scratch", "-1", "--pretty=%s",
    ]);
    expect(stdout.trim()).toBe("branch work");
  }, 30_000);

  it("E5: an embedded repo never becomes a gitlink in the parent's pushed tree", async () => {
    const parent = path.join(ws, "acme", "folder");
    // A nested MOUNTED folder (its own repo + manifest entry), NOT gitignored
    // by the parent - the carve-out that should exist is missing.
    const childBare = await seededBare(root, "acme/folder/child");
    await exec("git", ["clone", childBare, path.join(parent, "child")]);
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
      { mountPath: "acme/folder/child", repoName: "acme/folder/child.git", folderId: "f2" },
    ]);
    // Plus a repo the user just cloned in there (unknown to the manifest).
    const vendor = path.join(parent, "vendor");
    await mkdir(vendor);
    await exec("git", ["init", "-b", "main", vendor]);
    await writeFile(path.join(vendor, "lib.md"), "# vendored\n");

    // Edits on both levels.
    await writeFile(path.join(parent, "parent.md"), "# parent edit\n");
    await writeFile(path.join(parent, "child", "child.md"), "# child edit\n");

    const res = await save({ workspace: ws, message: "nested edit" });
    expect(res.errors).toHaveLength(0);

    // Parent's remote tree: the parent edit, but NO gitlink for child/vendor.
    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "main"]);
    expect(tree).toContain("parent.md");
    expect(tree).not.toMatch(/^160000/m);
    expect(tree).not.toContain("vendor");
    // The child's edit went to the CHILD's repo.
    const verify = path.join(root, "verify-child");
    await exec("git", ["clone", childBare, verify]);
    expect(await readFile(path.join(verify, "child.md"), "utf8")).toContain("child edit");
  }, 30_000);
});

describe("save edge cases (A pass: staged creates)", () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-edges-a-"));
    ws = path.join(root, "workspace");
    await mkdir(path.join(ws, "acme"), { recursive: true });
    await writeManifest(ws, []);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function pendingFor(slug: string): PendingCreate {
    return {
      brainId: "b1",
      slug,
      name: slug,
      path: slug,
      parentFolderId: null,
      mountPath: `acme/${slug}`,
      parentMount: "acme",
    };
  }

  it("E4: a staged dir that is already a repo pushes to the BRAIN, not its old origin", async () => {
    // The staged dir is a clone of some unrelated repo: it has an `origin`.
    const foreignBare = await seededBare(root, "foreign");
    await exec("git", ["clone", foreignBare, path.join(ws, "acme", "import")]);
    await writeFile(path.join(ws, "acme", "import", "doc.md"), "# brain content\n");
    await writePending(ws, { creates: [pendingFor("import")] });

    const brainBare = path.join(root, "remote", "b1-import.git");
    await mkdir(path.dirname(brainBare), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", brainBare]);
    const proxy = await fakeProxy({ createUrls: { import: brainBare } });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      expect(res.errors).toHaveLength(0);
      expect(res.created).toEqual([{ mountPath: "acme/import" }]);

      // The brain repo received the content...
      const verify = path.join(root, "verify-import");
      await exec("git", ["clone", brainBare, verify]);
      expect(await readFile(path.join(verify, "doc.md"), "utf8")).toContain("brain content");
      // ...and the foreign remote was NOT touched (still only its seed commit).
      const { stdout } = await exec("git", ["-C", foreignBare, "rev-list", "--count", "main"]);
      expect(stdout.trim()).toBe("1");
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("E6: a staged EMPTY folder is created, wired, and usable on the next save", async () => {
    await mkdir(path.join(ws, "acme", "notes"), { recursive: true });
    await writePending(ws, { creates: [pendingFor("notes")] });

    const brainBare = path.join(root, "remote", "b1-notes.git");
    await mkdir(path.dirname(brainBare), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", brainBare]);
    const proxy = await fakeProxy({ createUrls: { notes: brainBare } });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      expect(res.errors).toHaveLength(0);
      expect(res.created).toEqual([{ mountPath: "acme/notes" }]);
      // The remote actually has a main branch now (the create pushed).
      const { stdout } = await exec("git", ["-C", brainBare, "rev-list", "--count", "main"]);
      expect(Number(stdout.trim())).toBeGreaterThan(0);

      // The folder is wired: a file added later lands on the remote too.
      await writeManifest(ws, [
        { mountPath: "acme/notes", repoName: "b1/notes.git", folderId: "id-notes" },
      ]);
      await writeFile(path.join(ws, "acme", "notes", "first.md"), "# first\n");
      const res2 = await save({ workspace: ws, message: "first note" });
      expect(res2.errors).toHaveLength(0);
      const verify = path.join(root, "verify-notes");
      await exec("git", ["clone", brainBare, verify]);
      expect(await readFile(path.join(verify, "first.md"), "utf8")).toContain("first");
    } finally {
      proxy.close();
    }
  }, 30_000);
});

describe("save edge cases (P1: honest reporting)", () => {
  let root: string;
  let ws: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-edges-p1-"));
    bare = await seededBare(root, "acme/folder");
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
    await exec("git", ["clone", bare, path.join(ws, "acme", "folder")]);
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("E7: a broken manifest route does not block the M pass", async () => {
    await writeFile(path.join(ws, "acme", "folder", "note.md"), "# still saves\n");
    const proxy = await fakeProxy({ manifestStatus: 500 });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      // The lifecycle failure is reported...
      expect(res.errors.length).toBeGreaterThan(0);
      // ...but the folder still committed and pushed.
      expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "saved" }]);
      const verify = path.join(root, "verify-e7");
      await exec("git", ["clone", bare, verify]);
      expect(await readFile(path.join(verify, "note.md"), "utf8")).toContain("still saves");
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("E8: a dir whose .git is missing errors loudly instead of skipping", async () => {
    const folder = path.join(ws, "acme", "folder");
    await rm(path.join(folder, ".git"), { recursive: true, force: true });
    await writeFile(path.join(folder, "orphan.md"), "# never saved\n");

    const res = await save({ workspace: ws });

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.mountPath).toBe("acme/folder");
    expect(res.errors[0]!.error).toMatch(/monora sync/);
    expect(res.saved).toHaveLength(0);
  }, 30_000);

  it("E9: dry-run lists dirty folders in the plan (and commits nothing)", async () => {
    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "dirty.md"), "# pending edit\n");
    const proxy = await fakeProxy({
      entries: [{ folderId: "f1", repoName: "acme/folder.git", mountPath: "acme/folder" }],
    });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t", dryRun: true });
      expect(res.plan?.changed).toEqual(["acme/folder"]);
      // Nothing committed: the edit is still uncommitted on disk.
      const { stdout } = await git(folder, "status", "--porcelain");
      expect(stdout).toContain("dirty.md");
    } finally {
      proxy.close();
    }
  }, 30_000);
});

describe("save edge cases (round 2: adversarial findings)", () => {
  let root: string;
  let ws: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-edges-r2-"));
    bare = await seededBare(root, "acme/folder");
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
    await exec("git", ["clone", bare, path.join(ws, "acme", "folder")]);
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("F2: a repo nested BELOW an untracked dir never becomes a gitlink", async () => {
    const folder = path.join(ws, "acme", "folder");
    // Porcelain collapses this to `?? sub/` - the .git is one level deeper.
    const nested = path.join(folder, "sub", "nested");
    await mkdir(nested, { recursive: true });
    await exec("git", ["init", "-b", "main", nested]);
    await writeFile(path.join(nested, "x.md"), "x\n");
    await writeFile(path.join(folder, "sub", "doc.md"), "# sibling doc\n");
    await writeFile(path.join(folder, "edit.md"), "# edit\n");

    const res = await save({ workspace: ws, message: "deep nest" });
    expect(res.errors).toHaveLength(0);

    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "-r", "main"]);
    expect(tree).not.toMatch(/^160000/m);
    expect(tree).toContain("edit.md");
    // The sibling doc next to the nested repo still saves.
    expect(tree).toContain("sub/doc.md");
  }, 30_000);

  it("F3: a repo inside an already-TRACKED dir never becomes a gitlink", async () => {
    const folder = path.join(ws, "acme", "folder");
    // `docs/` is tracked content first...
    await mkdir(path.join(folder, "docs"));
    await writeFile(path.join(folder, "docs", "guide.md"), "# guide\n");
    await save({ workspace: ws, message: "track docs" });
    // ...then the user git-inits INSIDE it (so it never shows as `?? docs/`).
    const vendor = path.join(folder, "docs", "vendor");
    await mkdir(vendor);
    await exec("git", ["init", "-b", "main", vendor]);
    await writeFile(path.join(vendor, "lib.md"), "# vendored\n");
    await writeFile(path.join(folder, "edit.md"), "# edit\n");

    const res = await save({ workspace: ws, message: "tracked-dir nest" });
    expect(res.errors).toHaveLength(0);

    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "-r", "main"]);
    expect(tree).not.toMatch(/^160000/m);
    expect(tree).toContain("edit.md");
  }, 30_000);

  it("F4: embedded repos in dirs with spaces/unicode names are still excluded", async () => {
    const folder = path.join(ws, "acme", "folder");
    for (const name of ["weird dir", "café-repo"]) {
      const dir = path.join(folder, name);
      await mkdir(dir, { recursive: true });
      await exec("git", ["init", "-b", "main", dir]);
      await writeFile(path.join(dir, "x.md"), "x\n");
    }
    await writeFile(path.join(folder, "edit.md"), "# edit\n");

    const res = await save({ workspace: ws, message: "quoted paths" });
    expect(res.errors).toHaveLength(0);

    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "-r", "main"]);
    expect(tree).not.toMatch(/^160000/m);
    expect(tree).toContain("edit.md");
    expect(tree).not.toContain("weird dir");
  }, 30_000);

  it("F5: a failing user pre-commit hook does not block the save", async () => {
    const folder = path.join(ws, "acme", "folder");
    const hook = path.join(folder, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(path.join(folder, "note.md"), "# hooked\n");

    const res = await save({ workspace: ws, message: "hook bypass" });
    expect(res.errors).toHaveLength(0);
    expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "saved" }]);

    const verify = path.join(root, "verify-hook");
    await exec("git", ["clone", bare, verify]);
    expect(await readFile(path.join(verify, "note.md"), "utf8")).toContain("hooked");
  }, 30_000);

  it("F7: nested pending creates apply parents-first and stay separate repos", async () => {
    // Stage the child BEFORE the parent: the A pass must reorder by depth.
    await mkdir(path.join(ws, "acme", "area", "sub"), { recursive: true });
    await writeFile(path.join(ws, "acme", "area", "top.md"), "# area\n");
    await writeFile(path.join(ws, "acme", "area", "sub", "leaf.md"), "# sub\n");
    const child: PendingCreate = {
      brainId: "b1",
      slug: "sub",
      name: "sub",
      path: "area/sub",
      parentFolderId: null,
      mountPath: "acme/area/sub",
      parentMount: "acme",
    };
    const parent: PendingCreate = {
      brainId: "b1",
      slug: "area",
      name: "area",
      path: "area",
      parentFolderId: null,
      mountPath: "acme/area",
      parentMount: "acme",
    };
    await writePending(ws, { creates: [child, parent] });

    const areaBare = path.join(root, "remote", "b1-area.git");
    const subBare = path.join(root, "remote", "b1-sub.git");
    for (const b of [areaBare, subBare]) {
      await mkdir(path.dirname(b), { recursive: true });
      await exec("git", ["init", "--bare", "-b", "main", b]);
    }
    const proxy = await fakeProxy({ createUrls: { area: areaBare, sub: subBare } });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      expect(res.errors).toHaveLength(0);
      expect(res.created.map((c) => c.mountPath).sort()).toEqual([
        "acme/area",
        "acme/area/sub",
      ]);
      // The parent repo holds its own file but NOT the child's content/gitlink.
      const { stdout: areaTree } = await exec("git", ["-C", areaBare, "ls-tree", "-r", "main"]);
      expect(areaTree).toContain("top.md");
      expect(areaTree).not.toContain("leaf.md");
      expect(areaTree).not.toMatch(/^160000/m);
      // The child's content lives in the child's repo.
      const verify = path.join(root, "verify-sub");
      await exec("git", ["clone", subBare, verify]);
      expect(await readFile(path.join(verify, "leaf.md"), "utf8")).toContain("sub");
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("F14: an AA gitlink conflict (the only change) is healed by a re-save", async () => {
    // Both sides committed a gitlink for the nested mount `child` (the
    // historical corruption), with different pointers - the merge leaves an
    // AA conflict on `child` and NOTHING else. The excluded path keeps the
    // filtered status empty, but the merge must still be concluded: the
    // gitlink is dropped from the index and the merge commit pushed.
    const folder = path.join(ws, "acme", "folder");
    const SHA_A = "a".repeat(40);
    const SHA_B = "b".repeat(40);
    // Remote side: another machine pushes a gitlink for child.
    const other = path.join(root, "other-gitlink");
    await exec("git", ["clone", bare, other]);
    await exec("git", ["-C", other, "update-index", "--add", "--cacheinfo", `160000,${SHA_A},child`]);
    await exec("git", [...IDENT, "-C", other, "commit", "-m", "remote gitlink"]);
    await git(other, "push", "origin", "main");
    // Local side: a DIFFERENT gitlink for the same path, plus the child as a
    // real nested mount on disk.
    await exec("git", ["-C", folder, "update-index", "--add", "--cacheinfo", `160000,${SHA_B},child`]);
    await exec("git", [...IDENT, "-C", folder, "commit", "-m", "local gitlink"]);
    const childBare = await seededBare(root, "acme/folder/child");
    await exec("git", ["clone", childBare, path.join(folder, "child")]);
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
      { mountPath: "acme/folder/child", repoName: "acme/folder/child.git", folderId: "f2" },
    ]);

    // First save: push fails, merge leaves the AA gitlink conflict in place.
    const first = await save({ workspace: ws, message: "diverge" });
    expect(first.conflicts).toEqual([{ mountPath: "acme/folder", files: ["child"] }]);

    // Re-save: no markers anywhere (a dir has none) -> the merge is concluded
    // with the gitlink dropped, and pushed.
    const second = await save({ workspace: ws, message: "heal" });
    expect(second.conflicts).toHaveLength(0);
    expect(second.errors).toHaveLength(0);

    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "-r", "main"]);
    expect(tree).not.toMatch(/^160000/m);
    expect(tree).toContain("readme.md");
    // The child mount on disk is untouched.
    expect((await lstat(path.join(folder, "child", ".git"))).isDirectory()).toBe(true);
  }, 30_000);

  it("F13: a parent whose nested mounts are gitignored (carved out) still saves", async () => {
    // The healthy nested layout: the parent's .gitignore carves the child out.
    // Naming an ignored path in an :(exclude) pathspec makes some git versions
    // refuse the whole add ("paths are ignored") - the exclude must be skipped
    // for paths .gitignore already covers.
    const parent = path.join(ws, "acme", "folder");
    const childBare = await seededBare(root, "acme/folder/child");
    await exec("git", ["clone", childBare, path.join(parent, "child")]);
    await writeFile(path.join(parent, ".gitignore"), "/child/\n");
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
      { mountPath: "acme/folder/child", repoName: "acme/folder/child.git", folderId: "f2" },
    ]);
    await writeFile(path.join(parent, "edit.md"), "# parent edit\n");

    const res = await save({ workspace: ws, message: "carved-out nested save" });

    expect(res.errors).toHaveLength(0);
    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "-r", "main"]);
    expect(tree).toContain("edit.md");
    expect(tree).not.toMatch(/^160000/m);
  }, 30_000);

  it("F12: a corrupted manifest says so, instead of 'not a workspace'", async () => {
    await writeFile(path.join(ws, ".monora", "manifest.json"), "{ truncated");
    await expect(save({ workspace: ws })).rejects.toThrow(/rebuild|corrupt/i);
  }, 30_000);
});

describe("save edge cases (P2: guard boundaries + content smoke)", () => {
  let root: string;
  let ws: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-edges-p2-"));
    ws = path.join(root, "workspace");
    await mkdir(path.join(ws, ".monora"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function mountPlain(slugs: string[]) {
    for (const slug of slugs) {
      const dir = path.join(ws, "acme", slug);
      await mkdir(dir, { recursive: true });
      await exec("git", ["init", "-b", "main", dir]);
      await writeFile(path.join(dir, "x.md"), "x\n");
    }
    await writeManifest(
      ws,
      slugs.map((s) => ({
        mountPath: `acme/${s}`,
        repoName: `acme/${s}.git`,
        folderId: `id-${s}`,
      })),
    );
  }

  function entriesFor(slugs: string[]) {
    return slugs.map((s) => ({
      folderId: `id-${s}`,
      repoName: `acme/${s}.git`,
      mountPath: `acme/${s}`,
    }));
  }

  it("E10a: 2 of 3 folders deleted archives both (below the en-masse threshold)", async () => {
    const slugs = ["a", "b", "c"];
    await mountPlain(slugs);
    await rm(path.join(ws, "acme", "a"), { recursive: true, force: true });
    await rm(path.join(ws, "acme", "b"), { recursive: true, force: true });
    const proxy = await fakeProxy({ entries: entriesFor(slugs) });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      expect(res.guarded).toHaveLength(0);
      expect(proxy.archived.sort()).toEqual(["id-a", "id-b"]);
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("E10b: 3 of 5 folders deleted trips the guard (majority of >=3)", async () => {
    const slugs = ["a", "b", "c", "d", "e"];
    await mountPlain(slugs);
    for (const s of ["a", "b", "c"]) {
      await rm(path.join(ws, "acme", s), { recursive: true, force: true });
    }
    const proxy = await fakeProxy({ entries: entriesFor(slugs) });
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      expect(res.guarded.sort()).toEqual(["acme/a", "acme/b", "acme/c"]);
      expect(proxy.archived).toHaveLength(0);
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("E11: binary files, symlinks and unicode names round-trip to the remote", async () => {
    const bare = await seededBare(root, "acme/folder");
    await exec("git", ["clone", bare, path.join(ws, "acme", "folder")]);
    await writeManifest(ws, [
      { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
    ]);
    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    await writeFile(path.join(folder, "ñandú 文档 plan.md"), "# unicode\n");
    await symlink("readme.md", path.join(folder, "link-to-readme"));

    const res = await save({ workspace: ws, message: "smoke" });
    expect(res.errors).toHaveLength(0);

    const verify = path.join(root, "verify-smoke");
    await exec("git", ["clone", bare, verify]);
    const bin = await readFile(path.join(verify, "logo.png"));
    expect(bin[0]).toBe(0x89);
    expect(await readFile(path.join(verify, "ñandú 文档 plan.md"), "utf8")).toContain("unicode");
    expect((await lstat(path.join(verify, "link-to-readme"))).isSymbolicLink()).toBe(true);
  }, 30_000);
});
