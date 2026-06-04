import { serve } from "@hono/node-server";
import { createProxyApp } from "./app";
import { buildDeps } from "./deps";

/**
 * Standalone entry. The proxy authenticates tokens cross-org, so it uses the
 * owner database URL. Terminate TLS at a reverse proxy in front of this.
 */
const port = Number(process.env.GIT_PROXY_PORT ?? 3002);
const databaseUrl =
  process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL ?? "";
const gitRoot = process.env.GIT_ROOT ?? "/tmp/monora-git";
// Where the connector sends users to approve a device login (browser).
const appUrl = process.env.MONORA_APP_URL ?? "https://app.monora.ai";

if (!databaseUrl) {
  console.error("git-proxy: DATABASE_URL_OWNER (or DATABASE_URL) is required");
  process.exit(1);
}

const app = createProxyApp(buildDeps({ databaseUrl, gitRoot, appUrl }));
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`monora git-proxy listening on :${info.port} (GIT_ROOT=${gitRoot})`);
});
