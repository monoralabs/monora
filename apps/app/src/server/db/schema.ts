// Shim: the canonical domain schema (brains, folders, folder_access, audit_log)
// lives in @monora/db. Re-exported here so existing `@/server/db/schema`
// imports keep resolving.
export * from "@monora/db/schema";
