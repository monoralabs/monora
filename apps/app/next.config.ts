import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Validate env at build time (see src/env.ts).
  // @monora/brand is a workspace package shipped as source CSS; nothing to transpile.
  // The domain/data packages ship as TS source, so Next must transpile them.
  transpilePackages: ["@monora/core", "@monora/db", "@monora/git"],
  experimental: {
    // tRPC + React Query work fine with the default App Router setup.
  },
  // Standalone output keeps the Docker image small on Hetzner.
  output: "standalone",
  // We live in a pnpm monorepo, so point file tracing at the repo root. This
  // keeps the standalone bundle's layout as /<root>/apps/app/server.js with a
  // shared /<root>/node_modules, and ensures workspace deps are traced.
  outputFileTracingRoot: path.join(import.meta.dirname, "..", ".."),
};

export default nextConfig;
