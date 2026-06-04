import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeRepoName, makeSlug } from "@monora/core";
import { GitShellBackend } from "../git-shell-backend";

const exec = promisify(execFile);

let root: string;
let gitRoot: string;
let source: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "monora-git-test-"));
  gitRoot = path.join(root, "git");
  source = path.join(root, "src");
  await mkdir(gitRoot, { recursive: true });
  await mkdir(path.join(source, "sub"), { recursive: true });
  await writeFile(path.join(source, "vision.md"), "# Vision\n");
  await writeFile(path.join(source, "sub", "nested.md"), "nested\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const repo = makeRepoName("brain1", makeSlug("pd"));

describe("GitShellBackend", () => {
  it("creates a bare repo and snapshots a directory that clones back", async () => {
    const git = new GitShellBackend({ gitRoot });

    expect(await git.repoExists(repo)).toBe(false);
    await git.ensureBareRepo(repo, "main");
    expect(await git.repoExists(repo)).toBe(true);

    const { commit } = await git.importSnapshot({
      repoName: repo,
      sourceDir: source,
      branch: "main",
      message: "ingest pd",
    });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    // Clone the bare repo back and assert the content arrived.
    const clone = path.join(root, "clone1");
    await exec("git", ["clone", path.join(gitRoot, repo), clone]);
    expect(await readFile(path.join(clone, "vision.md"), "utf8")).toContain(
      "# Vision",
    );
    expect(
      await readFile(path.join(clone, "sub", "nested.md"), "utf8"),
    ).toContain("nested");
  });

  it("is idempotent and updates content on re-ingest", async () => {
    const git = new GitShellBackend({ gitRoot });
    await writeFile(path.join(source, "vision.md"), "# Vision v2\n");
    await git.ensureBareRepo(repo, "main"); // no-op
    await git.importSnapshot({
      repoName: repo,
      sourceDir: source,
      branch: "main",
      message: "ingest pd v2",
    });
    const clone = path.join(root, "clone2");
    await exec("git", ["clone", path.join(gitRoot, repo), clone]);
    expect(await readFile(path.join(clone, "vision.md"), "utf8")).toContain(
      "v2",
    );
  });

  it("re-ingest builds on the existing history (clones fast-forward, not unrelated)", async () => {
    const git = new GitShellBackend({ gitRoot });
    const src = path.join(root, "ff-src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "a.md"), "one\n");
    const ffRepo = makeRepoName("brain1", makeSlug("ff"));
    await git.ensureBareRepo(ffRepo, "main");
    const first = await git.importSnapshot({ repoName: ffRepo, sourceDir: src, branch: "main", message: "v1" });

    // A consumer clones it (like `monora sync`).
    const clone = path.join(root, "ff-clone");
    await exec("git", ["clone", path.join(gitRoot, ffRepo), clone]);

    // Source changes; re-ingest.
    await writeFile(path.join(src, "a.md"), "two\n");
    await writeFile(path.join(src, "b.md"), "new\n");
    const second = await git.importSnapshot({ repoName: ffRepo, sourceDir: src, branch: "main", message: "v2" });
    expect(second.commit).not.toBe(first.commit);

    // The clone FAST-FORWARDS - proving continuous history. The old
    // force-push-orphan made this fail with "unrelated histories".
    await exec("git", ["-C", clone, "pull", "--ff-only"]);
    expect(await readFile(path.join(clone, "a.md"), "utf8")).toContain("two");
    expect(await readFile(path.join(clone, "b.md"), "utf8")).toContain("new");
    // The first ingest commit is an ancestor of the second (history preserved).
    await exec("git", ["-C", clone, "merge-base", "--is-ancestor", first.commit, second.commit]);
  });

  it("re-ingest reflects deletions and no-ops when nothing changed", async () => {
    const git = new GitShellBackend({ gitRoot });
    const src = path.join(root, "del-src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "keep.md"), "k\n");
    await writeFile(path.join(src, "gone.md"), "g\n");
    const dRepo = makeRepoName("brain1", makeSlug("del"));
    await git.ensureBareRepo(dRepo, "main");
    await git.importSnapshot({ repoName: dRepo, sourceDir: src, branch: "main", message: "v1" });

    await rm(path.join(src, "gone.md"));
    const afterDel = await git.importSnapshot({ repoName: dRepo, sourceDir: src, branch: "main", message: "v2" });
    expect(await git.listFiles(dRepo)).not.toContain("gone.md");
    expect(await git.listFiles(dRepo)).toContain("keep.md");

    // Re-ingest with NO change leaves the branch tip exactly where it was.
    const noop = await git.importSnapshot({ repoName: dRepo, sourceDir: src, branch: "main", message: "v3" });
    expect(noop.commit).toBe(afterDel.commit);
  });

  it("carves out child subpaths and drops media from the snapshot", async () => {
    const git = new GitShellBackend({ gitRoot });
    const src = path.join(root, "carve-src");
    await mkdir(path.join(src, "contacts"), { recursive: true });
    await mkdir(path.join(src, "keep"), { recursive: true });
    await writeFile(path.join(src, "deals.json"), "{}\n"); // loose parent file
    await writeFile(path.join(src, "contacts", "ana.md"), "ana\n"); // carved
    await writeFile(path.join(src, "keep", "note.md"), "note\n"); // stays
    await writeFile(path.join(src, "logo.png"), "PNG"); // media, dropped
    await writeFile(path.join(src, "doc.pdf"), "PDF"); // doc, kept

    const carveRepo = makeRepoName("brain1", makeSlug("data"));
    await git.ensureBareRepo(carveRepo, "main");
    await git.importSnapshot({
      repoName: carveRepo,
      sourceDir: src,
      branch: "main",
      message: "ingest data",
      excludeSubpaths: ["contacts"],
      excludeMedia: true,
    });

    const files = await git.listFiles(carveRepo);
    expect(files).toContain("deals.json");
    expect(files).toContain("keep/note.md");
    expect(files).toContain("doc.pdf"); // documents are kept
    expect(files).not.toContain("logo.png"); // media dropped
    expect(files.some((f) => f.startsWith("contacts/"))).toBe(false); // carved out
  });

  it("never snapshots secrets, cruft, or dependency dirs", async () => {
    const git = new GitShellBackend({ gitRoot });
    const src = path.join(root, "ignore-src");
    await mkdir(path.join(src, "__pycache__"), { recursive: true });
    await mkdir(path.join(src, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(src, "skill.md"), "# skill\n");
    await writeFile(path.join(src, ".env"), "API_KEY=supersecret\n"); // must be dropped
    await writeFile(path.join(src, ".env.example"), "API_KEY=\n"); // must be kept
    await writeFile(path.join(src, ".DS_Store"), "junk");
    await writeFile(path.join(src, "__pycache__", "x.pyc"), "bytecode");
    await writeFile(path.join(src, "node_modules", "pkg", "index.js"), "x");

    const ignRepo = makeRepoName("brain1", makeSlug("skills"));
    await git.ensureBareRepo(ignRepo, "main");
    await git.importSnapshot({ repoName: ignRepo, sourceDir: src, branch: "main", message: "ingest" });

    const files = await git.listFiles(ignRepo);
    expect(files).toContain("skill.md");
    expect(files).toContain(".env.example"); // examples documary config, kept
    expect(files).not.toContain(".env"); // SECRET, never ingested
    expect(files).not.toContain(".DS_Store");
    expect(files.some((f) => f.startsWith("__pycache__/"))).toBe(false);
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("rejects a repo path escaping GIT_ROOT", async () => {
    const git = new GitShellBackend({ gitRoot });
    await expect(
      git.repoExists("../../etc/passwd" as ReturnType<typeof makeRepoName>),
    ).rejects.toThrow(/escapes GIT_ROOT/);
  });
});
