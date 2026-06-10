import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withWorkspaceLock, lockPath } from "../lock";
import { save } from "../save";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("workspace lock (one mutating command at a time)", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), "monora-lock-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("a second command on the same workspace is refused while the first runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withWorkspaceLock(ws, "sync", () => gate);

    await expect(withWorkspaceLock(ws, "save", async () => "nope")).rejects.toThrow(
      /already running/,
    );

    release();
    await first; // and the lock is gone afterwards
    expect(await exists(lockPath(ws))).toBe(false);
  });

  it("the lock is released even when the command throws", async () => {
    await expect(
      withWorkspaceLock(ws, "sync", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(await exists(lockPath(ws))).toBe(false);
    // The workspace is usable again.
    await expect(withWorkspaceLock(ws, "sync", async () => "ok")).resolves.toBe("ok");
  });

  it("a lock left by a CRASHED process (dead pid) is cleared automatically", async () => {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(
      lockPath(ws),
      JSON.stringify({ pid: 999999999, command: "sync", startedAt: "2026-01-01T00:00:00Z" }),
    );
    await expect(withWorkspaceLock(ws, "save", async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("a lock held by a LIVE process is respected, with a who/since message", async () => {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(
      lockPath(ws),
      JSON.stringify({ pid: process.pid, command: "sync", startedAt: "2026-06-10T10:00:00Z" }),
    );
    await expect(withWorkspaceLock(ws, "save", async () => "nope")).rejects.toThrow(
      new RegExp(`pid ${process.pid}`),
    );
    // Untouched: still there for its (live) holder.
    expect(await readFile(lockPath(ws), "utf8")).toContain(String(process.pid));
  });

  it("an unreadable lock file is never auto-deleted", async () => {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(lockPath(ws), "not json at all");
    await expect(withWorkspaceLock(ws, "save", async () => "nope")).rejects.toThrow(
      /already running/,
    );
    expect(await readFile(lockPath(ws), "utf8")).toBe("not json at all");
  });

  it("save refuses to run under another process's live lock", async () => {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(
      path.join(ws, ".monora", "manifest.json"),
      JSON.stringify({ orgId: "o", entries: [] }),
    );
    await writeFile(
      lockPath(ws),
      JSON.stringify({ pid: process.pid, command: "sync", startedAt: "2026-06-10T10:00:00Z" }),
    );
    await expect(save({ workspace: ws })).rejects.toThrow(/already running/);
  });
});
