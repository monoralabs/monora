# @monora/app - app.monora.ai

Next.js 16 (App Router) + Better Auth + Drizzle + tRPC. Self-hosted Postgres
with row-level security for multi-tenant isolation.

## Stack

- **Auth**: Better Auth (organization plugin = multi-tenancy, magic link, email
  OTP, Google/Microsoft social, Stripe subscriptions). Config in
  `src/server/auth/index.ts`.
- **DB**: Postgres + Drizzle. The app connects as the low-privilege `app_user`,
  so every query to a domain table is scoped by RLS (`src/server/db/tenant.ts`).
- **API**: tRPC (`src/server/api`). `orgProcedure` runs each resolver inside a
  tenant transaction.
- **AuthZ**: swappable `can(subject, action, space)` interface
  (`src/server/authz`) - a Postgres table today, OpenFGA later.
- **UI**: shadcn + `@monora/brand` design system.

## Run it locally

Prereqs: OrbStack (or Docker) running, and `mise` (env comes from
`../mise.local.toml`).

```bash
# 1. Postgres (host port 5433 to avoid colliding with a native PG on 5432)
cd apps/app
docker compose up -d

# 2. Create schema (runs as the owner role; app_user is created by docker init)
pnpm db:migrate         # or: pnpm db:push for a quick dev sync

# 3. Dev server (from the dev/ root, mise injects env)
cd ../.. && pnpm --filter @monora/app dev
# -> http://localhost:3000   (/ sign in · /dashboard)
```

## Scripts

| Script | What |
|---|---|
| `pnpm dev` | Next dev on :3000 |
| `pnpm db:generate` | Generate SQL migration from the Drizzle schema |
| `pnpm db:migrate` | Apply migrations (as owner) |
| `pnpm db:push` | Push schema directly (dev) |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm auth:generate` | Regenerate `src/server/db/auth-schema.ts` from the Better Auth config (run under Node 22) |

## Notes

- Stripe webhooks land at `/api/auth/stripe/webhook` (handled by the Better Auth
  Stripe plugin). Subscriptions are billed against the active organization.
- `auth-schema.ts` is the Better Auth table definitions; treat
  `pnpm auth:generate` as the source of truth and reconcile after plugin bumps.
