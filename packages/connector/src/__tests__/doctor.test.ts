import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctor, formatReport } from "../doctor";

const exec = promisify(execFile);

/**
 * doctor diagnoses the workspace from the live manifest + local tree, so each
 * test stubs `fetch` (the manifest) and lays down on-disk git folders to stand
 * in for synced ones - no real server.
 */
describe("doctor (self-diagnose folder visibility)", () => {
  let root: string;
  let ws: string;
  let creds: string;

  async function gitFolder(mountPath: string) {
    const dest = path.join(ws, mountPath);
    await mkdir(dest, { recursive: true });
    await exec("git", ["init", "-b", "main", dest]);
  }

  async function writeMeta(mountPaths: string[]) {
    await mkdir(path.join(ws, ".monora"), { recursive: true });
    await writeFile(
      path.join(ws, ".monora", "manifest.json"),
      JSON.stringify({
        orgId: "org_d",
        entries: mountPaths.map((m) => ({
          mountPath: m,
          repoName: `${m}.git`,
          folderId: m,
        })),
      }),
    );
  }

  function stubManifest(mountPaths: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          orgId: "org_d",
          subjectId: "user_estefania",
          entries: mountPaths.map((m) => ({
            mountPath: m,
            repoName: `${m}.git`,
          })),
        }),
      ),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-doctor-"));
    ws = path.join(root, "workspace");
    await mkdir(ws, { recursive: true });
    creds = path.join(root, "credentials.json");
    await writeFile(
      creds,
      JSON.stringify({ baseUrl: "https://git.monora.ai", token: "tok" }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("reports not-logged-in when there are no credentials", async () => {
    const report = await doctor({ workspace: ws, configPath: path.join(root, "nope.json") });
    expect(report.loggedIn).toBe(false);
    expect(report.actionable).toBe(true);
    expect(formatReport(report)[0]).toMatch(/not logged in/i);
  });

  it("is healthy when every shared folder is on disk", async () => {
    stubManifest(["dreamshot/work/alpha"]);
    await gitFolder("dreamshot/work/alpha");
    await writeMeta(["dreamshot/work/alpha"]);

    const report = await doctor({ workspace: ws, configPath: creds });
    expect(report.authValid).toBe(true);
    expect(report.authorizedCount).toBe(1);
    expect(report.onDiskCount).toBe(1);
    expect(report.missingOnDisk).toEqual([]);
    expect(report.actionable).toBe(false);
    expect(formatReport(report)[0]).toMatch(/healthy/i);
  });

  it("names a folder granted after the last sync (the lepas case)", async () => {
    stubManifest(["dreamshot/work/alpha", "dreamshot/work/lepas"]);
    await gitFolder("dreamshot/work/alpha");
    await writeMeta(["dreamshot/work/alpha"]); // lepas not synced yet

    const report = await doctor({ workspace: ws, configPath: creds });
    expect(report.missingOnDisk).toEqual(["dreamshot/work/lepas"]);
    expect(report.actionable).toBe(true);
    const out = formatReport(report).join("\n");
    expect(out).toContain("dreamshot/work/lepas");
    expect(out).toMatch(/monora sync/);
  });

  it("flags an invalid login on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const report = await doctor({ workspace: ws, configPath: creds });
    expect(report.authValid).toBe(false);
    expect(report.actionable).toBe(true);
    expect(formatReport(report)[0]).toMatch(/isn't valid/i);
  });

  it("reports an unreachable server when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const report = await doctor({ workspace: ws, configPath: creds });
    expect(report.reachable).toBe(false);
    expect(report.actionable).toBe(true);
    expect(formatReport(report)[0]).toMatch(/can't reach/i);
  });

  it("flags a revoked folder and a dirty one", async () => {
    stubManifest(["dreamshot/work/alpha"]);
    await gitFolder("dreamshot/work/alpha");
    await gitFolder("dreamshot/work/gone"); // on disk, no longer authorized
    await writeMeta(["dreamshot/work/alpha", "dreamshot/work/gone"]);
    // Make alpha dirty with an untracked file.
    await writeFile(path.join(ws, "dreamshot/work/alpha", "draft.md"), "wip\n");

    const report = await doctor({ workspace: ws, configPath: creds });
    expect(report.revoked).toEqual(["dreamshot/work/gone"]);
    expect(report.dirty).toEqual(["dreamshot/work/alpha"]);
    expect(report.actionable).toBe(true);
    const out = formatReport(report).join("\n");
    expect(out).toMatch(/no longer have access/i);
    expect(out).toMatch(/unsaved changes/i);
  });

  it("formats relative sync time", () => {
    const base: Parameters<typeof formatReport>[0] = {
      actionable: false,
      loggedIn: true,
      reachable: true,
      authValid: true,
      host: "git.monora.ai",
      isWorkspace: true,
      lastSyncAt: 1_000_000,
      authorizedCount: 3,
      onDiskCount: 3,
      missingOnDisk: [],
      revoked: [],
      dirty: [],
    };
    const out = formatReport(base, 1_000_000 + 3 * 60_000).join("\n");
    expect(out).toMatch(/Last sync: 3 minutes ago/);
  });
});
