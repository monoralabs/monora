import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveFolders } from "../derive";

describe("deriveFolders (local dir -> flat folder list)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "monora-derive-"));
    await mkdir(path.join(root, "product-development"), { recursive: true });
    await mkdir(path.join(root, "sales-development", "brand"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true }); // hidden, must be ignored
    await writeFile(path.join(root, "product-development", "vision.md"), "x");
    await writeFile(path.join(root, "README.md"), "root file");
    await writeFile(path.join(root, "CLAUDE.md"), "root file");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("makes one folder per top-level subdir, skips dotdirs", async () => {
    const { folders } = await deriveFolders(root);
    expect(folders.map((f) => f.slug).sort()).toEqual([
      "product-development",
      "sales-development",
    ]);
    const sd = folders.find((f) => f.slug === "sales-development")!;
    expect(sd.name).toBe("Sales Development");
    expect(sd.path).toBe("sales-development");
    expect(sd.source).toBe("sales-development");
  });

  it("reports loose root files (not ingested) and excludes .git", async () => {
    const { rootFiles } = await deriveFolders(root);
    expect(rootFiles.sort()).toEqual(["CLAUDE.md", "README.md"]);
  });

  it("rejects two subdirs that collapse to the same slug", async () => {
    const clash = await mkdtemp(path.join(tmpdir(), "monora-derive-clash-"));
    await mkdir(path.join(clash, "Sales Dev"), { recursive: true });
    await mkdir(path.join(clash, "sales-dev"), { recursive: true });
    await expect(deriveFolders(clash)).rejects.toThrow(/same slug/);
    await rm(clash, { recursive: true, force: true });
  });
});
