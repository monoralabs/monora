import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ancestorRepoTracking } from "../sync";

const exec = promisify(execFile);
const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

/** A committed git repo at `dir` tracking the given relative files. */
async function repoTracking(dir: string, files: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-b", "main", dir]);
  for (const f of files) {
    const fp = path.join(dir, f);
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, `# ${f}\n`);
  }
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", [...IDENT, "-C", dir, "commit", "-m", "seed"]);
}

describe("ancestorRepoTracking - detect a flattened-brain collision before clobbering", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), "monora-topo-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("flags a child mount whose files are tracked by a parent repo (the flat case)", async () => {
    // `dreamshot/skills` is one repo holding apollo/ as plain content.
    await repoTracking(path.join(ws, "dreamshot/skills"), ["apollo/SKILL.md", "finance/SKILL.md"]);
    // The server wants `dreamshot/skills/apollo` as its own repo.
    const dest = path.join(ws, "dreamshot/skills/apollo");
    const hit = await ancestorRepoTracking(dest, ws);
    expect(hit).toBe(path.join(ws, "dreamshot/skills"));
  });

  it("returns null when the parent carves the child out (.gitignore, tracks nothing there)", async () => {
    // Parent repo that does NOT track apollo/ (carved out) - the healthy nested layout.
    await repoTracking(path.join(ws, "dreamshot/skills"), ["README.md"]);
    const dest = path.join(ws, "dreamshot/skills/apollo");
    const hit = await ancestorRepoTracking(dest, ws);
    expect(hit).toBeNull();
  });

  it("returns null for a top-level brain root (no ancestor repo above it)", async () => {
    const dest = path.join(ws, "dreamshot");
    const hit = await ancestorRepoTracking(dest, ws);
    expect(hit).toBeNull();
  });
});
