#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createMonoraMcpClient } from "./client";

/**
 * Monora MCP server (stdio). The universal, leanest client piece: add it once
 * to any MCP agent (Claude Code / Codex / Cursor / ...) and the agent can read
 * and search ONLY the folders the token is authorized for - no clone.
 *
 * Credentials, in precedence order:
 *   1. env MONORA_URL + MONORA_TOKEN (explicit; what the web snippets set).
 *   2. the connector's stored credentials (`~/.monora/credentials.json`, written
 *      by `monora login`). This is why a workspace `.mcp.json` written by
 *      `monora sync` need not embed the secret - one login provisions both the
 *      git read+write tree and this read-only server.
 *
 * Install (Claude Code):  claude mcp add monora -- npx -y @monora-ai/mcp
 *   with env MONORA_URL and MONORA_TOKEN set, or after `monora login`.
 */

function loadCredentials(): { urlBase: string; token: string } {
  let urlBase = (process.env.MONORA_URL ?? "").replace(/\/+$/, "");
  let token = process.env.MONORA_TOKEN ?? "";
  if (urlBase && token) return { urlBase, token };
  // Fall back to the connector's credentials file (same path/override as
  // @monora-ai/connector's defaultConfigPath), so the secret lives in one place.
  const configPath =
    process.env.MONORA_CONFIG ??
    path.join(homedir(), ".monora", "credentials.json");
  try {
    const creds = JSON.parse(readFileSync(configPath, "utf8")) as {
      baseUrl?: string;
      token?: string;
    };
    if (!urlBase && creds.baseUrl) urlBase = creds.baseUrl.replace(/\/+$/, "");
    if (!token && creds.token) token = creds.token;
  } catch {
    // No usable credentials file; the guard below reports the error.
  }
  return { urlBase, token };
}

const { urlBase: URL_BASE, token: TOKEN } = loadCredentials();

if (!URL_BASE || !TOKEN) {
  console.error(
    "monora-mcp: set MONORA_URL and MONORA_TOKEN, or run `monora login` first",
  );
  process.exit(1);
}

const server = new McpServer({ name: "monora", version: "0.0.0" });
const client = createMonoraMcpClient({ urlBase: URL_BASE, token: TOKEN });

server.registerTool(
  "list_folders",
  {
    title: "List authorized folders",
    description:
      "List the Monora folders this token can access, with mount paths and permission. Call this first to discover what you can read.",
    inputSchema: {},
  },
  async () => client.listFolders(),
);

server.registerTool(
  "read_file",
  {
    title: "Read a file",
    description:
      "Read a file by its workspace path, e.g. 'product-development/vision.md'. The first segment is the folder mount path from list_folders.",
    inputSchema: { path: z.string().describe("workspace path to the file") },
  },
  async ({ path }) => client.readFile(path),
);

server.registerTool(
  "list_files",
  {
    title: "List files in a folder",
    description: "List every file path in one authorized folder (by mount path).",
    inputSchema: { folder: z.string().describe("folder mount path") },
  },
  async ({ folder }) => client.listFiles(folder),
);

server.registerTool(
  "search",
  {
    title: "Search the brain",
    description:
      "Full-text search across ALL folders this token can read. Returns matching path:line:text.",
    inputSchema: { query: z.string().describe("text to search for") },
  },
  async ({ query }) => client.search(query),
);

await server.connect(new StdioServerTransport());
