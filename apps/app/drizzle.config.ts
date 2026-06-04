import { defineConfig } from "drizzle-kit";

// drizzle-kit runs migrations/introspection as the OWNER role (DDL needs to
// bypass RLS). The running app uses DATABASE_URL (app_user) instead.
export default defineConfig({
  // Schema now lives in @monora/db (auth-schema + domain). Migrations stay here.
  schema: [
    "../../packages/db/src/auth-schema.ts",
    "../../packages/db/src/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL!,
  },
  // We manage RLS policies in schema.ts via pgPolicy(), so keep them in sync.
  verbose: true,
  strict: true,
});
