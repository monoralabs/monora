import { defineConfig } from "tsup";

// Bundle the CLI (and the small library export) to a single self-contained
// dist/ so the package is `npx -y @monora-ai/connector`-able. @monora/core is a
// type-only import here, so nothing internal ends up in the runtime bundle and
// the published package has zero runtime dependencies.
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  dts: false,
  splitting: false,
  shims: false,
});
