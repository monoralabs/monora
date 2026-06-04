import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installShim } from "../shim";

describe("installShim (self-install `monora` into a bin dir)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-shim-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates an executable shim that delegates to npx", async () => {
    const binDir = path.join(root, "fresh", "bin");
    const res = await installShim({ binDir, envPath: "/usr/bin", platform: "darwin" });
    expect(res.status).toBe("installed");
    expect(res.onPath).toBe(false);
    const body = await readFile(res.shimPath, "utf8");
    expect(body).toContain("#!/bin/sh");
    expect(body).toContain("npx -y @monora-ai/connector");
    const mode = (await stat(res.shimPath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("is idempotent and detects the bin dir on PATH", async () => {
    const binDir = path.join(root, "fresh", "bin");
    const res = await installShim({
      binDir,
      envPath: `/usr/bin${path.delimiter}${binDir}`,
      platform: "darwin",
    });
    expect(res.status).toBe("unchanged");
    expect(res.onPath).toBe(true);
  });

  it("rewrites an outdated shim of ours", async () => {
    const binDir = path.join(root, "stale", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "monora"), "#!/bin/sh\n# monora shim v0 (old)\nexec npx monora-old\n");
    const res = await installShim({ binDir, envPath: "", platform: "linux" });
    expect(res.status).toBe("updated");
    const body = await readFile(res.shimPath, "utf8");
    expect(body).toContain("@monora-ai/connector");
  });

  it("never touches a foreign `monora` at that path", async () => {
    const binDir = path.join(root, "foreign", "bin");
    await mkdir(binDir, { recursive: true });
    const foreign = "#!/bin/sh\necho my own script\n";
    await writeFile(path.join(binDir, "monora"), foreign);
    const res = await installShim({ binDir, envPath: "", platform: "darwin" });
    expect(res.status).toBe("skipped-foreign");
    expect(await readFile(res.shimPath, "utf8")).toBe(foreign);
  });

  it("skips on Windows", async () => {
    const binDir = path.join(root, "win", "bin");
    const res = await installShim({ binDir, envPath: "", platform: "win32" });
    expect(res.status).toBe("skipped-platform");
    await expect(stat(res.shimPath)).rejects.toThrow();
  });
});
