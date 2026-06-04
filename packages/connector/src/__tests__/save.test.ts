import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { save } from "../save";

const exec = promisify(execFile);
const IDENT = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
];

async function git(cwd: string, ...args: string[]) {
  return exec("git", ["-C", cwd, ...args]);
}

/**
 * A self-contained save round-trip with no server: a bare repo stands in for
 * the proxy, a clone stands in for a synced folder, and we assert the bare repo
 * actually receives the commit `save` makes.
 */
describe("save (commit + push every changed folder)", () => {
  let root: string;
  let ws: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-save-"));
    bare = path.join(root, "remote", "acme", "folder.git");
    await mkdir(path.dirname(bare), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", bare]);

    // Seed the bare repo with an initial commit so the clone has an upstream.
    const seed = path.join(root, "seed");
    await exec("git", ["clone", bare, seed]);
    await writeFile(path.join(seed, "readme.md"), "# seed\n");
    await git(seed, "add", "-A");
    await exec("git", [...IDENT, "-C", seed, "commit", "-m", "seed"]);
    await git(seed, "push", "-u", "origin", "main");

    // The workspace: the folder cloned at its mount path + a manifest, exactly
    // what `monora sync` would have produced.
    ws = path.join(root, "workspace");
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await exec("git", ["clone", bare, path.join(ws, "acme", "folder")]);
    await writeFile(
      path.join(ws, ".monora", "manifest.json"),
      JSON.stringify({
        orgId: "org_save",
        entries: [
          { mountPath: "acme/folder", repoName: "acme/folder.git", folderId: "f1" },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("commits + pushes a changed folder, and the remote receives it", async () => {
    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "vision.md"), "# the thesis\n");

    const res = await save({ workspace: ws, message: "add vision" });

    expect(res.errors).toHaveLength(0);
    expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "saved" }]);

    // The commit reached the bare remote: a fresh clone reads the new file and
    // the message we passed.
    const verify = path.join(root, "verify");
    await exec("git", ["clone", bare, verify]);
    expect(await readFile(path.join(verify, "vision.md"), "utf8")).toContain(
      "the thesis",
    );
    const { stdout: log } = await git(verify, "log", "-1", "--pretty=%s");
    expect(log.trim()).toBe("add vision");
  }, 30_000);

  it("is a no-op when nothing changed", async () => {
    const res = await save({ workspace: ws, message: "nothing" });
    expect(res.errors).toHaveLength(0);
    expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "clean" }]);
  }, 30_000);

  it("pushes commits made by hand but not yet pushed", async () => {
    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "manual.md"), "# committed by hand\n");
    await git(folder, "add", "-A");
    await exec("git", [...IDENT, "-C", folder, "commit", "-m", "manual commit"]);

    const res = await save({ workspace: ws });
    expect(res.errors).toHaveLength(0);
    expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "pushed" }]);

    const verify = path.join(root, "verify2");
    await exec("git", ["clone", bare, verify]);
    expect(await readFile(path.join(verify, "manual.md"), "utf8")).toContain(
      "committed by hand",
    );
  }, 30_000);

  it("throws when the directory is not a Monora workspace", async () => {
    const empty = path.join(root, "empty");
    await mkdir(empty, { recursive: true });
    await expect(save({ workspace: empty })).rejects.toThrow(/monora sync/);
  });

  it("merges a diverged remote (different files) and pushes - no conflict", async () => {
    // Another writer advances the remote on a DIFFERENT file.
    const other = path.join(root, "other");
    await exec("git", ["clone", bare, other]);
    await writeFile(path.join(other, "remote-only.md"), "# from elsewhere\n");
    await git(other, "add", "-A");
    await exec("git", [...IDENT, "-C", other, "commit", "-m", "remote change"]);
    await git(other, "push", "origin", "main");

    // We edit a different file locally, then save.
    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "local-only.md"), "# my edit\n");
    const res = await save({ workspace: ws, message: "local edit" });

    expect(res.errors).toHaveLength(0);
    expect(res.conflicts).toHaveLength(0);
    expect(res.saved).toEqual([{ mountPath: "acme/folder", action: "saved" }]);

    // The remote now has BOTH sides.
    const verify = path.join(root, "verify-merge");
    await exec("git", ["clone", bare, verify]);
    expect(await readFile(path.join(verify, "remote-only.md"), "utf8")).toContain("from elsewhere");
    expect(await readFile(path.join(verify, "local-only.md"), "utf8")).toContain("my edit");
  }, 30_000);

  it("reports a conflict (same lines) and leaves markers, without blocking", async () => {
    // Another writer changes the SAME line we are about to change.
    const other = path.join(root, "other2");
    await exec("git", ["clone", bare, other]);
    await writeFile(path.join(other, "readme.md"), "# seed\nremote wins\n");
    await git(other, "add", "-A");
    await exec("git", [...IDENT, "-C", other, "commit", "-m", "remote edit"]);
    await git(other, "push", "origin", "main");

    const folder = path.join(ws, "acme", "folder");
    await writeFile(path.join(folder, "readme.md"), "# seed\nlocal wins\n");
    const res = await save({ workspace: ws, message: "local edit" });

    // The folder is reported as conflicted, not errored; nothing is lost.
    expect(res.errors).toHaveLength(0);
    expect(res.conflicts).toEqual([
      { mountPath: "acme/folder", files: ["readme.md"] },
    ]);
    // Conflict markers are left in the working tree for resolution.
    expect(await readFile(path.join(folder, "readme.md"), "utf8")).toContain("<<<<<<<");
  }, 30_000);
});

import { createServer, type Server } from "node:http";

/** A fake proxy that serves a manifest and records archive requests. */
function fakeProxy(
  entries: { folderId: string; repoName: string; mountPath: string }[] = [],
): Promise<{
  baseUrl: string;
  archived: string[];
  close: () => void;
}> {
  const archived: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orgId: "org_recon", entries }));
      return;
    }
    const m = req.url?.match(/^\/folders\/([^/]+)\/archive$/);
    if (req.method === "POST" && m) {
      archived.push(m[1]!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ archived: [m[1]] }));
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
        close: () => server.close(),
      });
    });
  });
}

describe("save reconcile (the D in A/M/D: a deleted folder is archived)", () => {
  let root: string;
  let ws: string;
  const MANIFEST = [{ folderId: "id-alpha", repoName: "acme/alpha.git", mountPath: "acme/alpha" }, { folderId: "id-beta", repoName: "acme/beta.git", mountPath: "acme/beta" }];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-recon-"));
    ws = path.join(root, "workspace");
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    // Two synced folders (real git dirs so the M pass is happy), indexed with
    // their folder ids - what `monora sync` writes.
    for (const slug of ["alpha", "beta"]) {
      const dir = path.join(ws, "acme", slug);
      await mkdir(dir, { recursive: true });
      await exec("git", ["init", "-b", "main", dir]);
      await writeFile(path.join(dir, "x.md"), "x\n");
    }
    await writeFile(
      path.join(ws, ".monora", "manifest.json"),
      JSON.stringify({
        orgId: "org_recon",
        entries: [
          { mountPath: "acme/alpha", repoName: "acme/alpha.git", folderId: "id-alpha" },
          { mountPath: "acme/beta", repoName: "acme/beta.git", folderId: "id-beta" },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("archives a folder removed from disk (and tells the proxy its id)", async () => {
    await rm(path.join(ws, "acme", "beta"), { recursive: true, force: true });
    const proxy = await fakeProxy(MANIFEST);
    try {
      const res = await save({
        workspace: ws,
        baseUrl: proxy.baseUrl,
        token: "t",
      });
      expect(res.archived).toEqual([{ mountPath: "acme/beta" }]);
      expect(proxy.archived).toEqual(["id-beta"]);
      expect(res.guarded).toHaveLength(0);
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("dry-run reports the delete plan but archives nothing", async () => {
    await rm(path.join(ws, "acme", "beta"), { recursive: true, force: true });
    const proxy = await fakeProxy(MANIFEST);
    try {
      const res = await save({
        workspace: ws,
        baseUrl: proxy.baseUrl,
        token: "t",
        dryRun: true,
      });
      expect(res.plan?.delete).toEqual(["acme/beta"]);
      expect(proxy.archived).toHaveLength(0);
      expect(res.archived).toHaveLength(0);
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("the guard refuses to archive when the WHOLE workspace is gone", async () => {
    await rm(path.join(ws, "acme", "alpha"), { recursive: true, force: true });
    await rm(path.join(ws, "acme", "beta"), { recursive: true, force: true });
    const proxy = await fakeProxy(MANIFEST);
    try {
      const res = await save({ workspace: ws, baseUrl: proxy.baseUrl, token: "t" });
      expect(proxy.archived).toHaveLength(0); // nothing archived
      expect(res.guarded.sort()).toEqual(["acme/alpha", "acme/beta"]);
      expect(res.archived).toHaveLength(0);
    } finally {
      proxy.close();
    }
  }, 30_000);

  it("--force overrides the guard and archives the lot", async () => {
    await rm(path.join(ws, "acme", "alpha"), { recursive: true, force: true });
    await rm(path.join(ws, "acme", "beta"), { recursive: true, force: true });
    const proxy = await fakeProxy(MANIFEST);
    try {
      const res = await save({
        workspace: ws,
        baseUrl: proxy.baseUrl,
        token: "t",
        force: true,
      });
      expect(proxy.archived.sort()).toEqual(["id-alpha", "id-beta"]);
      expect(res.archived).toHaveLength(2);
      expect(res.guarded).toHaveLength(0);
    } finally {
      proxy.close();
    }
  }, 30_000);
});
