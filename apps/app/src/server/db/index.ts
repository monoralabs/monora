import "server-only";
import { createDb, schema } from "@monora/db";
import { env } from "@/env";

// Single pool per server process, reused across HMR reloads in dev. The app
// connects as app_user (non-superuser), so every query is subject to RLS. The
// client/adapters/UoW all live in @monora/db; this file is just the app's
// composition of the singleton.
const globalForDb = globalThis as unknown as {
  db?: ReturnType<typeof createDb>;
};

export const db = globalForDb.db ?? createDb(env.DATABASE_URL);

if (env.NODE_ENV !== "production") globalForDb.db = db;

export type DB = typeof db;
export { schema };
