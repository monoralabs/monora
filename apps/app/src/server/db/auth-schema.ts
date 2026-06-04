// Shim: the canonical Better Auth schema now lives in @monora/db so it can be
// shared with the connector/proxy/ingest. The Better Auth CLI (`pnpm
// auth:generate`) writes to ../../packages/db/src/auth-schema.ts. Keep this
// re-export so existing `@/server/db/auth-schema` imports resolve.
export * from "@monora/db/auth-schema";
