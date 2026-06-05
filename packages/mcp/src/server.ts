#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

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

interface MountEntry {
  repoName: string;
  mountPath: string;
  permission: string;
}

async function api(path: string): Promise<Response> {
  return fetch(`${URL_BASE}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function manifest(): Promise<MountEntry[]> {
  const res = await api("/manifest");
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const data = (await res.json()) as { entries: MountEntry[] };
  return data.entries;
}

/** Map a workspace path ("product-development/vision.md") to its repo + the
 *  in-repo path, using the manifest's mount points. */
async function resolve(
  path: string,
): Promise<{ repo: string; rel: string } | null> {
  const clean = path.replace(/^\/+/, "");
  for (const e of await manifest()) {
    if (clean === e.mountPath || clean.startsWith(e.mountPath + "/")) {
      return { repo: e.repoName, rel: clean.slice(e.mountPath.length + 1) };
    }
  }
  return null;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "monora", version: "0.0.0" });

server.registerTool(
  "list_folders",
  {
    title: "List authorized folders",
    description:
      "List the Monora folders this token can access, with mount paths and permission. Call this first to discover what you can read.",
    inputSchema: {},
  },
  async () => {
    const entries = await manifest();
    if (!entries.length) return text("No folders authorized for this token.");
    return text(
      entries
        .map((e) => `- ${e.mountPath}/  (${e.permission})  [${e.repoName}]`)
        .join("\n"),
    );
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read a file",
    description:
      "Read a file by its workspace path, e.g. 'product-development/vision.md'. The first segment is the folder mount path from list_folders.",
    inputSchema: { path: z.string().describe("workspace path to the file") },
  },
  async ({ path }) => {
    const r = await resolve(path);
    if (!r) return text(`No authorized folder for path: ${path}`);
    const res = await api(
      `/read?repo=${encodeURIComponent(r.repo)}&path=${encodeURIComponent(r.rel)}`,
    );
    if (res.status === 401) return text("Access denied.");
    if (!res.ok) return text(`Not found: ${path}`);
    const data = (await res.json()) as { content: string };
    return text(data.content);
  },
);

server.registerTool(
  "list_files",
  {
    title: "List files in a folder",
    description: "List every file path in one authorized folder (by mount path).",
    inputSchema: { folder: z.string().describe("folder mount path") },
  },
  async ({ folder }) => {
    const entry = (await manifest()).find((e) => e.mountPath === folder);
    if (!entry) return text(`No authorized folder: ${folder}`);
    const res = await api(`/tree?repo=${encodeURIComponent(entry.repoName)}`);
    if (!res.ok) return text("Access denied.");
    const data = (await res.json()) as { files: string[] };
    return text(data.files.map((f) => `${folder}/${f}`).join("\n"));
  },
);

server.registerTool(
  "search",
  {
    title: "Search the brain",
    description:
      "Full-text search across ALL folders this token can read. Returns matching path:line:text.",
    inputSchema: { query: z.string().describe("text to search for") },
  },
  async ({ query }) => {
    const res = await api(`/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return text("Search failed.");
    const data = (await res.json()) as {
      results: { mountPath: string; matches: string[] }[];
    };
    if (!data.results.length) return text(`No matches for "${query}".`);
    return text(
      data.results
        .map(
          (r) =>
            `## ${r.mountPath}\n` +
            r.matches.map((m) => m.replace(/^HEAD:/, "")).join("\n"),
        )
        .join("\n\n"),
    );
  },
);

await server.connect(new StdioServerTransport());
