import { defineConfig } from "tsup";

// Bundle the stdio MCP server to dist/server.js so `npx -y @monora-ai/mcp` works.
// @modelcontextprotocol/sdk and zod stay external (real runtime deps that npm
// installs alongside the package).
export default defineConfig({
  entry: { server: "src/server.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  dts: false,
  splitting: false,
  shims: false,
});
