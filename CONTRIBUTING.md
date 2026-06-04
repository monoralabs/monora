# Contributing to Monora

Thanks for your interest. Monora is pre-1.0 and developed in the open.

## Develop

- Node >= 22.12, pnpm 8.15.5 (via corepack).
- `pnpm install`
- Run the stack: `cp .env.example .env` (set `BETTER_AUTH_SECRET` + the two Postgres passwords), then `docker compose up -d`.
- Checks (CI runs exactly these): `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @monora/app build`.

## Pull requests

- Branch off `main` and open a PR. Keep commits focused; conventional-commit style is appreciated.
- CI (lint, typecheck, test, build) must be green.
- A **CLA** (the Apache ICLA, via cla-assistant) will be required before external contributions can be merged. This line will link it once it is wired up.

## Architecture

`packages/core` is the domain (pure, DDD / hexagonal); adapters live in `packages/git` and `packages/db`; the apps wire them together. The git proxy is the authorization chokepoint. See [CLAUDE.md](./CLAUDE.md) for the full map and conventions - the repo is meant to be agent-operable.

## Scope

The supported open-source case is **self-hosted, single-org**. Multi-tenant cloud operations (billing, managed hosting) are out of scope for this repo.
