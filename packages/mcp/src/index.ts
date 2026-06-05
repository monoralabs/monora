// Library surface for the MCP package. The published artifact is the CLI
// server (see `bin`); this entry exists so workspace code (e.g. tests) can
// reuse the client logic without reaching into internal files.
export {
  createMonoraMcpClient,
  type MonoraMcpClientOptions,
  type TextToolResult,
} from "./client";
