import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMcpConfig } from "../sync";

describe("writeMcpConfig", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), "monora-mcp-cfg-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  async function readConfig() {
    return JSON.parse(await readFile(path.join(ws, ".mcp.json"), "utf8"));
  }

  it("creates .mcp.json wiring the npx server and embeds no secret", async () => {
    await writeMcpConfig(ws);
    const cfg = await readConfig();
    expect(cfg.mcpServers.monora).toEqual({
      command: "npx",
      args: ["-y", "@monora-ai/mcp"],
    });
    // The whole point: the token lives in the credentials file, never here.
    expect(JSON.stringify(cfg)).not.toContain("MONORA_TOKEN");
    expect(JSON.stringify(cfg)).not.toContain("mna_");
  });

  it("merges into an existing file, preserving other servers", async () => {
    await writeFile(
      path.join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: { other: { command: "node", args: ["x.js"] } },
      }),
    );
    await writeMcpConfig(ws);
    const cfg = await readConfig();
    expect(cfg.mcpServers.other).toEqual({ command: "node", args: ["x.js"] });
    expect(cfg.mcpServers.monora.command).toBe("npx");
  });

  it("does not clobber an unparseable existing file", async () => {
    const file = path.join(ws, ".mcp.json");
    await writeFile(file, "{ not valid json");
    await writeMcpConfig(ws);
    expect(await readFile(file, "utf8")).toBe("{ not valid json");
  });
});
