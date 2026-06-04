# AGENTS.md

Monora is the company brain for people **and** AI agents, so this repo is meant to be agent-operable. If you're an agent (or a human) working here, start with this file; see [CLAUDE.md](./CLAUDE.md) for the full map and the product voice.

## Commands

- **Install:** `pnpm install` (Node >= 22.12, pnpm 8.15.5 via corepack)
- **Typecheck:** `pnpm -r typecheck`
- **Test:** `pnpm -r test` (the git-proxy and connector e2e suites need Postgres; CI provides it)
- **Build:** `pnpm --filter @monora/app build`
- **Run the stack:** `cp .env.example .env` then `docker compose up -d`

CI runs exactly: typecheck, test, build, lint. Make those pass locally before opening a PR.

## Architecture (where things live)

- `packages/core` - domain + application layer (DDD / hexagonal), pure and infra-free. Business rules and ports live here.
- `packages/git`, `packages/db` - adapters (git over bare repos; Postgres + Drizzle).
- `apps/git-proxy` - git smart-HTTP and the **authorization chokepoint**.
- `apps/app` - the Next.js product (orgs, folders, per-folder access, the Brain explorer).
- `packages/connector` (`@monora-ai/connector`) and `packages/mcp` (`@monora-ai/mcp`) - the CLI and the MCP server.

## Conventions (do not break)

- Authorization is a single chokepoint. The tenant is derived from the brain id, **never** trusted from the URL. A token's scopes **intersect** the folder ACL and never widen it.
- Multi-tenant isolation is Postgres **RLS** keyed on `org_id`. Never query domain tables outside the tenant transaction, and never use the owner DB role at request time.
- The domain layer (`packages/core/src/domain`) must stay infra-free: no `node:*`, no db, no http.
- Never hardcode a secret. Config comes from env (`.env.example` documents it).
