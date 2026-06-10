import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { update, detectMode, currentVersion } from "../update";
import { shimBody } from "../shim";

function fakeRegistry(version: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("update - detectMode", () => {
  it("recognizes the npx shim (env var or _npx cache path)", () => {
    expect(detectMode("/whatever/dist/cli.js", { MONORA_SHIM: "1" })).toBe("npx-shim");
    expect(
      detectMode("/Users/x/.npm/_npx/abc123/node_modules/.bin/monora", {}),
    ).toBe("npx-shim");
  });

  it("recognizes npm and pnpm global installs", () => {
    expect(detectMode("/usr/local/lib/node_modules/@monora-ai/connector/dist/cli.js", {})).toBe("npm-global");
    expect(detectMode("/Users/x/Library/pnpm/global/5/node_modules/@monora-ai/connector/dist/cli.js", {})).toBe("pnpm-global");
  });

  it("treats anything else as a local build", () => {
    expect(detectMode("/Users/x/dev/monora/monora-cloud/packages/connector/dist/cli.js", {})).toBe("local-build");
  });
});

describe("update - outcomes", () => {
  let dir: string;
  let calls: { cmd: string; args: string[] }[];
  const run = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "monora-update-"));
    calls = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports up-to-date (and runs nothing) when the registry matches", async () => {
    const mine = await currentVersion();
    const res = await update({ fetchFn: fakeRegistry(mine), run, env: {} });
    expect(res.action).toBe("up-to-date");
    expect(calls).toEqual([]);
  });

  it("shim mode: warms the npx cache with the exact version and pins the shim", async () => {
    const shimPath = path.join(dir, "monora");
    await writeFile(shimPath, shimBody()); // the bare-spec shim login installs
    const res = await update({
      fetchFn: fakeRegistry("9.9.9"),
      run,
      env: { MONORA_SHIM: "1" },
      argv1: "/x/dist/cli.js",
      shimPath,
    });
    expect(res.action).toBe("updated-shim");
    expect(calls).toEqual([
      { cmd: "npx", args: ["-y", "@monora-ai/connector@9.9.9", "--version"] },
    ]);
    // The shim now runs the pinned version.
    expect(await readFile(shimPath, "utf8")).toContain("@monora-ai/connector@9.9.9");
  });

  it("shim mode: never rewrites a foreign file at the shim path", async () => {
    const shimPath = path.join(dir, "monora");
    await writeFile(shimPath, "#!/bin/sh\n# the user's own script\n");
    const res = await update({
      fetchFn: fakeRegistry("9.9.9"),
      run,
      env: { MONORA_SHIM: "1" },
      argv1: "/x/dist/cli.js",
      shimPath,
    });
    expect(res.action).toBe("updated-shim");
    expect(await readFile(shimPath, "utf8")).toContain("the user's own script");
    expect(res.detail).toMatch(/left untouched/);
  });

  it("global mode: runs the right package manager", async () => {
    const res = await update({
      fetchFn: fakeRegistry("9.9.9"),
      run,
      env: {},
      argv1: "/usr/local/lib/node_modules/@monora-ai/connector/dist/cli.js",
    });
    expect(res.action).toBe("updated-global");
    expect(calls).toEqual([
      { cmd: "npm", args: ["install", "-g", "@monora-ai/connector@9.9.9"] },
    ]);
  });

  it("local build: explains instead of touching anything", async () => {
    const res = await update({
      fetchFn: fakeRegistry("9.9.9"),
      run,
      env: {},
      argv1: "/Users/x/dev/monora/monora-cloud/packages/connector/dist/cli.js",
    });
    expect(res.action).toBe("manual");
    expect(calls).toEqual([]);
    expect(res.detail).toMatch(/local build/);
  });
});

describe("update - Windows spawning", () => {
  it("uses a shell on win32 (npm/npx are .cmd batch files there)", async () => {
    const { spawnOptionsFor } = await import("../update");
    expect(spawnOptionsFor("win32").shell).toBe(true);
    expect(spawnOptionsFor("darwin").shell).toBe(false);
    expect(spawnOptionsFor("linux").shell).toBe(false);
  });
});
