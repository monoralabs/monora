import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collapse } from "../collapse";
import { readPending, writePending, type PendingCreate, type ServerEntry } from "../lifecycle";

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

describe("collapse edge cases", () => {
  let root: string;
  let ws: string;
  let bare: string;
  let archiveCalls: string[];
  let server: ServerEntry[];
  const ORIGINAL_FETCH = globalThis.fetch;

  const PARENT: ServerEntry = {
    folderId: "p",
    repoName: "acme/skills.git",
    mountPath: "dreamshot/skills",
  };
  const CHILD: ServerEntry = {
    folderId: "c1",
    repoName: "acme/skills-apollo.git",
    mountPath: "dreamshot/skills/apollo",
  };

  function wireFetch() {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/manifest")) {
        return Response.json({ orgId: "o", subjectId: "u", entries: server });
      }
      const m = u.match(/\/folders\/([^/]+)\/archive$/);
      if (m && init?.method === "POST") {
        archiveCalls.push(m[1]!);
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
  }

  /** Parent repo cloned from `bare`, holding apollo/ as plain content. */
  async function seedParent(): Promise<string> {
    const parent = path.join(ws, "dreamshot/skills");
    await mkdir(path.dirname(parent), { recursive: true });
    await exec("git", ["clone", bare, parent]);
    await mkdir(path.join(parent, "apollo"), { recursive: true });
    await writeFile(path.join(parent, "apollo", "SKILL.md"), "# apollo\n");
    await writeFile(path.join(parent, "README.md"), "# skills\n");
    await exec("git", ["-C", parent, "add", "-A"]);
    await exec("git", [...IDENT, "-C", parent, "commit", "-m", "seed"]);
    await exec("git", ["-C", parent, "push", "-u", "origin", "main"]);
    return parent;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-collapse-edges-"));
    ws = path.join(root, "workspace");
    bare = path.join(root, "remote", "skills.git");
    await mkdir(path.dirname(bare), { recursive: true });
    await exec("git", ["init", "--bare", "-b", "main", bare]);
    archiveCalls = [];
    server = [PARENT, CHILD];
    wireFetch();
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await rm(root, { recursive: true, force: true });
  });

  it("C1: an unmounted parent fails BEFORE anything is mutated", async () => {
    // Parent exists on disk but is not a repo; its .gitignore carves apollo out.
    const parent = path.join(ws, "dreamshot/skills");
    await mkdir(path.join(parent, "apollo"), { recursive: true });
    await writeFile(path.join(parent, "apollo", "SKILL.md"), "# apollo\n");
    await writeFile(path.join(parent, ".gitignore"), "/apollo/\n");

    await expect(
      collapse({ baseUrl: "https://git.test", token: "t", workspace: ws, target: "dreamshot/skills" }),
    ).rejects.toThrow(/sync it first/);

    // The .gitignore was NOT un-carved by a doomed run, and nothing archived.
    expect(await readFile(path.join(parent, ".gitignore"), "utf8")).toContain("/apollo/");
    expect(archiveCalls).toEqual([]);
  }, 30_000);

  it("C2: a skipped own-repo child never becomes a gitlink in the parent's push", async () => {
    const parent = await seedParent();
    // proj is its own repo locally (skipped) and NOT carved out of the parent.
    server = [
      ...server,
      { folderId: "c2", repoName: "acme/skills-proj.git", mountPath: "dreamshot/skills/proj" },
    ];
    const proj = path.join(parent, "proj");
    await mkdir(proj, { recursive: true });
    await exec("git", ["init", "-b", "main", proj]);
    await writeFile(path.join(proj, "p.md"), "# proj\n");

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });
    expect(res.archived.map((a) => a.mountPath)).toEqual(["dreamshot/skills/apollo"]);

    // The parent's pushed tree holds apollo but NO gitlink (mode 160000).
    const { stdout: tree } = await exec("git", ["-C", bare, "ls-tree", "-r", "main"]);
    expect(tree).toContain("apollo/SKILL.md");
    expect(tree).not.toMatch(/^160000/m);
  }, 30_000);

  it("C4: a child the parent did NOT absorb is not archived", async () => {
    const parent = await seedParent();
    // A gitignore VARIANT unCarve does not recognize ("apollo/" without the
    // leading slash) keeps the parent ignoring apollo after the un-carve pass.
    await writeFile(path.join(parent, ".gitignore"), "apollo/\n");
    await exec("git", ["-C", parent, "rm", "-r", "--cached", "--ignore-unmatch", "apollo"]);
    await exec("git", ["-C", parent, "add", "-A"]);
    await exec("git", [...IDENT, "-C", parent, "commit", "-m", "carve variant"]);
    await exec("git", ["-C", parent, "push", "origin", "main"]);

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });

    // The child was NOT silently archived out of the manifest while its files
    // never reached the parent's repo.
    expect(archiveCalls).toEqual([]);
    expect(res.archived).toEqual([]);
    expect(res.errors.some((e) => e.mountPath === "dreamshot/skills/apollo" && /absorb|ignored/i.test(e.error))).toBe(true);
    // Content untouched on disk.
    expect(await exists(path.join(parent, "apollo", "SKILL.md"))).toBe(true);
  }, 30_000);

  it("C3a: a diverged parent remote is merged, pushed, and the collapse completes", async () => {
    await seedParent();
    // Another machine advances the parent's remote on a different file.
    const other = path.join(root, "other");
    await exec("git", ["clone", bare, other]);
    await writeFile(path.join(other, "elsewhere.md"), "# from another machine\n");
    await exec("git", ["-C", other, "add", "-A"]);
    await exec("git", [...IDENT, "-C", other, "commit", "-m", "remote work"]);
    await exec("git", ["-C", other, "push", "origin", "main"]);
    // Carve apollo so the collapse has real work to commit + push.
    const parent = path.join(ws, "dreamshot/skills");
    await writeFile(path.join(parent, ".gitignore"), "/apollo/\n");
    await exec("git", ["-C", parent, "rm", "-r", "--cached", "--ignore-unmatch", "apollo"]);
    await exec("git", ["-C", parent, "add", "-A"]);
    await exec("git", [...IDENT, "-C", parent, "commit", "-m", "carve"]);

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });

    expect(res.errors).toEqual([]);
    expect(res.archived.map((a) => a.mountPath)).toEqual(["dreamshot/skills/apollo"]);
    // The bare repo holds BOTH sides: the other machine's file and apollo.
    const verify = path.join(root, "verify-diverged");
    await exec("git", ["clone", bare, verify]);
    expect(await exists(path.join(verify, "elsewhere.md"))).toBe(true);
    expect(await exists(path.join(verify, "apollo", "SKILL.md"))).toBe(true);
  }, 30_000);

  it("C3b: a hard push failure reports an error and archives NOTHING", async () => {
    await seedParent();
    await rm(bare, { recursive: true, force: true }); // the remote is gone

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });

    expect(archiveCalls).toEqual([]);
    expect(res.archived).toEqual([]);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]!.mountPath).toBe("dreamshot/skills");
  }, 30_000);

  it("C5: a hostile child mount path cannot reach outside the workspace", async () => {
    await seedParent();
    server = [
      PARENT,
      { folderId: "evil", repoName: "acme/evil.git", mountPath: "dreamshot/skills/../../../evil" },
    ];
    // A victim .gitignore outside the workspace that an unguarded unCarve/rm
    // could touch must stay untouched.
    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });

    expect(archiveCalls).not.toContain("evil");
    expect(res.errors.some((e) => /mount path/i.test(e.error))).toBe(true);
  }, 30_000);

  it("C6: pending creates under the collapsed parent are unstaged", async () => {
    await seedParent();
    const under: PendingCreate = {
      brainId: "b1",
      slug: "new-skill",
      name: "new-skill",
      path: "skills/new-skill",
      parentFolderId: null,
      mountPath: "dreamshot/skills/new-skill",
      parentMount: "dreamshot/skills",
    };
    const outside: PendingCreate = {
      ...under,
      slug: "elsewhere",
      name: "elsewhere",
      path: "elsewhere",
      mountPath: "dreamshot/elsewhere",
      parentMount: "dreamshot",
    };
    await writePending(ws, { creates: [under, outside] });

    const res = await collapse({
      baseUrl: "https://git.test",
      token: "t",
      workspace: ws,
      target: "dreamshot/skills",
    });

    expect(res.archived.map((a) => a.mountPath)).toEqual(["dreamshot/skills/apollo"]);
    // The staged re-split under the collapsed parent is gone; unrelated stays.
    const pending = await readPending(ws);
    expect(pending.creates.map((c) => c.mountPath)).toEqual(["dreamshot/elsewhere"]);
    expect(res.unstaged).toEqual(["dreamshot/skills/new-skill"]);
  }, 30_000);
});
