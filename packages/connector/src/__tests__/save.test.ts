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
        entries: [{ mountPath: "acme/folder", repoName: "acme/folder.git" }],
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
});
