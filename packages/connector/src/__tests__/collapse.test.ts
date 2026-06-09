import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collapse, planCollapse } from "../collapse";
import type { ServerEntry } from "../lifecycle";

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

describe("planCollapse - pick the parent and its descendants", () => {
  const entries: ServerEntry[] = [
    { folderId: "p", repoName: "b/work.git", mountPath: "b/work" },
    { folderId: "c1", repoName: "b/work-mtng.git", mountPath: "b/work/mtng" },
    { folderId: "c2", repoName: "b/work-strad.git", mountPath: "b/work/stradivarius" },
    { folderId: "x", repoName: "b/skills.git", mountPath: "b/skills" },
  ];
  const allFlat = () => true;

  it("returns only the descendants mounted strictly under the target, deepest first", () => {
    const plan = planCollapse(entries, "b/work", allFlat);
    expect(plan.parentMount).toBe("b/work");
    expect(plan.children.map((c) => c.mountPath)).toEqual([
      "b/work/mtng",
      "b/work/stradivarius",
    ]);
  });

  it("tolerates a trailing slash and excludes unrelated folders", () => {
    const plan = planCollapse(entries, "b/work/", allFlat);
    expect(plan.children.map((c) => c.folderId)).not.toContain("x");
  });

  it("splits descendants into foldable (flat) vs skipped (their own repo)", () => {
    // Only work/mtng is flat; stradivarius is its own repo -> left alone.
    const flat = (e: ServerEntry) => e.mountPath === "b/work/mtng";
    const plan = planCollapse(entries, "b/work", flat);
    expect(plan.children.map((c) => c.mountPath)).toEqual(["b/work/mtng"]);
    expect(plan.skipped.map((c) => c.mountPath)).toEqual(["b/work/stradivarius"]);
  });
});

describe("collapse - fold children into the parent and archive them", () => {
  let root: string;
  let ws: string;
  let bare: string;
  let archiveCalls: string[];
  const ORIGINAL_FETCH = globalThis.fetch;

  // A bare repo stands in for the parent's remote so the real push works.
  const SERVER: ServerEntry[] = [
    { folderId: "p", repoName: "acme/skills.git", mountPath: "dreamshot/skills" },
    { folderId: "c1", repoName: "acme/skills-apollo.git", mountPath: "dreamshot/skills/apollo" },
  ];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-collapse-"));
    ws = path.join(root, "workspace");
    bare = path.join(root, "remote", "skills.git");
    await mkdir(path.dirname(bare), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", bare]);

    // The parent folder, cloned + already holding apollo/ as plain content (the
    // flattened-brain state collapse targets).
    const parent = path.join(ws, "dreamshot/skills");
    await mkdir(parent, { recursive: true });
    await exec("git", ["clone", bare, parent]);
    await mkdir(path.join(parent, "apollo"), { recursive: true });
    await writeFile(path.join(parent, "apollo", "SKILL.md"), "# apollo\n");
    await writeFile(path.join(parent, "README.md"), "# skills\n");
    await exec("git", ["-C", parent, "add", "-A"]);
    await exec("git", [...IDENT, "-C", parent, "commit", "-m", "seed"]);
    await exec("git", ["-C", parent, "push", "-u", "origin", "main"]);

    archiveCalls = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/manifest")) {
        return Response.json({ orgId: "o", subjectId: "u", entries: SERVER });
      }
      const m = u.match(/\/folders\/([^/]+)\/archive$/);
      if (m && init?.method === "POST") {
        archiveCalls.push(m[1]!);
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await rm(root, { recursive: true, force: true });
  });

  it("dry run lists the children and changes nothing", async () => {
    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
      dryRun: true,
    });
    expect(res.plan?.children.map((c) => c.mountPath)).toEqual([
      "dreamshot/skills/apollo",
    ]);
    expect(res.archived).toEqual([]);
    expect(archiveCalls).toEqual([]); // nothing archived on a dry run
  });

  it("archives the child and the parent repo keeps the content", async () => {
    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });
    expect(res.archived.map((a) => a.mountPath)).toEqual(["dreamshot/skills/apollo"]);
    expect(archiveCalls).toEqual(["c1"]); // the child folder id was archived
    // Content is still on disk under the parent, and pushed to the parent's bare repo.
    expect(await exists(path.join(ws, "dreamshot/skills/apollo/SKILL.md"))).toBe(true);
    const verify = path.join(root, "verify");
    await exec("git", ["clone", bare, verify]);
    expect(await exists(path.join(verify, "apollo/SKILL.md"))).toBe(true);
  });

  it("leaves a child that is its own repo locally alone (does not archive it)", async () => {
    // Server splits skills into apollo (flat locally) AND proj (its own repo).
    const mixed: ServerEntry[] = [
      ...SERVER,
      { folderId: "c2", repoName: "acme/skills-proj.git", mountPath: "dreamshot/skills/proj" },
    ];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/manifest")) {
        return Response.json({ orgId: "o", subjectId: "u", entries: mixed });
      }
      const m = u.match(/\/folders\/([^/]+)\/archive$/);
      if (m && init?.method === "POST") {
        archiveCalls.push(m[1]!);
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    // proj is mounted as its own repo locally.
    const proj = path.join(ws, "dreamshot/skills/proj");
    await mkdir(proj, { recursive: true });
    await exec("git", ["init", "-b", "main", proj]);
    await writeFile(path.join(proj, "p.md"), "# proj\n");
    await exec("git", [...IDENT, "-C", proj, "add", "-A"]);
    await exec("git", [...IDENT, "-C", proj, "commit", "-m", "proj"]);

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });
    expect(res.archived.map((a) => a.mountPath)).toEqual(["dreamshot/skills/apollo"]);
    expect(res.skipped.map((s) => s.mountPath)).toEqual(["dreamshot/skills/proj"]);
    expect(archiveCalls).toEqual(["c1"]); // proj's folderId c2 was NOT archived
    expect(await exists(path.join(proj, ".git"))).toBe(true); // still its own repo
  });

  it("un-carves a child that the parent had gitignored, so the parent tracks it", async () => {
    const parent = path.join(ws, "dreamshot/skills");
    // Simulate a properly carved-out nested layout: apollo/ is gitignored.
    await writeFile(path.join(parent, ".gitignore"), "/apollo/\n");
    await exec("git", ["-C", parent, "rm", "-r", "--cached", "--ignore-unmatch", "apollo"]);
    await exec("git", ["-C", parent, "add", "-A"]);
    await exec("git", [...IDENT, "-C", parent, "commit", "-m", "carve out apollo"]);

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });
    expect(res.uncarved).toContain("dreamshot/skills/apollo");
    const ignore = await readFile(path.join(parent, ".gitignore"), "utf8");
    expect(ignore).not.toMatch(/\/apollo\//);
    // apollo is now tracked by the parent again.
    const { stdout } = await exec("git", ["-C", parent, "ls-files", "--", "apollo"]);
    expect(stdout).toMatch(/apollo\/SKILL\.md/);
  });
});
