import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Manifest, MountEntry } from "@monora/core";
import { reconcileRemovals } from "../sync";
import {
  applyScope,
  brainOf,
  readWorkspaceScope,
  scopeAllows,
  scopeIsActive,
  writeWorkspaceScope,
} from "../scope";

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

describe("scope - pure helpers", () => {
  it("brainOf takes the first mount-path segment", () => {
    expect(brainOf("dreamshot/skills/apollo")).toBe("dreamshot");
    expect(brainOf("dreamshot")).toBe("dreamshot");
  });

  it("scopeIsActive is false for an empty or listless scope", () => {
    expect(scopeIsActive(null)).toBe(false);
    expect(scopeIsActive({})).toBe(false);
    expect(scopeIsActive({ brains: [] })).toBe(false);
    expect(scopeIsActive({ brains: ["dreamshot"] })).toBe(true);
    expect(scopeIsActive({ orgs: ["o1"] })).toBe(true);
  });

  it("scopeAllows keeps a folder when its brain OR its org matches", () => {
    const s = { brains: ["dreamshot"], orgs: ["orgX"] };
    expect(scopeAllows(s, "dreamshot", "orgA")).toBe(true); // brain hit
    expect(scopeAllows(s, "monora", "orgX")).toBe(true); // org hit
    expect(scopeAllows(s, "monora", "orgA")).toBe(false); // neither
    // A missing list contributes no matches (never an implicit "allow all").
    expect(scopeAllows({ brains: ["dreamshot"] }, "monora", "orgA")).toBe(false);
  });

  it("applyScope narrows the manifest to the kept folders", () => {
    const full = manifest("orgA", [
      entry("dreamshot", "orgA"),
      entry("dreamshot/skills", "orgA"),
      entry("monora-guide/guide", "orgG"),
      entry("monora/overview", "orgM"),
    ]);
    const scoped = applyScope(full, { brains: ["dreamshot"] });
    expect(scoped.entries.map((e) => e.mountPath)).toEqual([
      "dreamshot",
      "dreamshot/skills",
    ]);
    // Untouched fields carry over.
    expect(scoped.orgId).toBe("orgA");
  });
});

describe("scope - readWorkspaceScope (fails open)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), "monora-scope-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("returns null when there is no scope file", async () => {
    expect(await readWorkspaceScope(ws)).toBeNull();
  });

  it("round-trips a written scope", async () => {
    await writeWorkspaceScope(ws, { brains: ["dreamshot"] });
    expect(await readWorkspaceScope(ws)).toEqual({ brains: ["dreamshot"] });
  });

  it("treats an empty scope as no filter", async () => {
    await writeWorkspaceScope(ws, { brains: [] });
    expect(await readWorkspaceScope(ws)).toBeNull();
  });

  it("ignores non-string list members and blanks", async () => {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(
      path.join(ws, ".monora", "workspace.json"),
      JSON.stringify({ brains: ["dreamshot", "", 7, null], orgs: "nope" }),
    );
    expect(await readWorkspaceScope(ws)).toEqual({ brains: ["dreamshot"] });
  });

  it("fails open (null) on malformed JSON - never hides folders on a typo", async () => {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(path.join(ws, ".monora", "workspace.json"), "{ not json");
    expect(await readWorkspaceScope(ws)).toBeNull();
  });
});

/** A clean, fully-pushed working tree at `<ws>/<mountPath>` (origin set, HEAD on
 *  the remote) - the only state the prune will delete. */
async function mountPushedFolder(
  ws: string,
  bareRoot: string,
  mountPath: string,
): Promise<void> {
  const bare = path.join(bareRoot, mountPath.replace(/\//g, "_") + ".git");
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  const dir = path.join(ws, mountPath);
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-b", "main", dir]);
  await writeFile(path.join(dir, "readme.md"), `# ${mountPath}\n`);
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [...IDENT, "-C", dir, "commit", "-m", "seed"]);
  await exec("git", ["-C", dir, "remote", "add", "origin", bare]);
  await exec("git", ["-C", dir, "push", "-u", "origin", "main"]);
}

async function writeMeta(
  ws: string,
  orgId: string,
  entries: { mountPath: string; repoName: string; folderId: string; orgId: string }[],
): Promise<void> {
  await mkdir(path.join(ws, ".monora"), { recursive: true });
  await writeFile(
    path.join(ws, ".monora", "manifest.json"),
    JSON.stringify({ orgId, entries }, null, 2),
  );
}

function emptyResult() {
  return {
    mounted: [],
    removed: [] as string[],
    conflicts: [],
    readOnlyAhead: [] as { mountPath: string }[],
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

describe("scope - prune distinguishes out-of-scope from out-of-reach", () => {
  let ws: string;
  let bareRoot: string;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), "monora-scope-prune-"));
    bareRoot = await mkdtemp(path.join(tmpdir(), "monora-scope-bare-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(bareRoot, { recursive: true, force: true });
  });

  it("prunes an out-of-scope brain whose org the token still covers", async () => {
    await mountPushedFolder(ws, bareRoot, "dreamshot/skills");
    await mountPushedFolder(ws, bareRoot, "guide/readme");
    await writeMeta(ws, "orgA", [
      { mountPath: "dreamshot/skills", repoName: "orgA/skills.git", folderId: "f1", orgId: "orgA" },
      { mountPath: "guide/readme", repoName: "orgG/guide.git", folderId: "f2", orgId: "orgG" },
    ]);

    // Scoped manifest keeps only dreamshot; the FULL manifest still lists the
    // guide (its org orgG is authorized, just out of scope here).
    const scoped = manifest("orgA", [entry("dreamshot/skills", "orgA")]);
    const full = manifest("orgA", [
      entry("dreamshot/skills", "orgA"),
      entry("guide/readme", "orgG"),
    ]);

    const result = emptyResult();
    await reconcileRemovals(ws, scoped, result, full);

    expect(await exists(path.join(ws, "dreamshot/skills"))).toBe(true);
    expect(await exists(path.join(ws, "guide/readme"))).toBe(false);
    expect(result.removed).toContain("guide/readme");
  });

  it("leaves a folder alone when its org is out of the token's reach", async () => {
    await mountPushedFolder(ws, bareRoot, "dreamshot/skills");
    await mountPushedFolder(ws, bareRoot, "guide/readme");
    await writeMeta(ws, "orgA", [
      { mountPath: "dreamshot/skills", repoName: "orgA/skills.git", folderId: "f1", orgId: "orgA" },
      { mountPath: "guide/readme", repoName: "orgG/guide.git", folderId: "f2", orgId: "orgG" },
    ]);

    // Here the full manifest does NOT cover orgG - the token genuinely can't
    // see it (not a scope choice). The guide must survive, exactly as a
    // narrow-scoped sync must never wipe a sibling org's brain.
    const scoped = manifest("orgA", [entry("dreamshot/skills", "orgA")]);
    const result = emptyResult();
    await reconcileRemovals(ws, scoped, result, scoped);

    expect(await exists(path.join(ws, "guide/readme"))).toBe(true);
    expect(result.removed).toEqual([]);
  });
});
