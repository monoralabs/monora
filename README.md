# Monora

**The self-hosted company brain: git-versioned folders with per-folder permissions, for people and AI agents.**

[![CI](https://github.com/monoralabs/monora/actions/workflows/ci.yml/badge.svg)](https://github.com/monoralabs/monora/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Monora keeps your company's knowledge as folders in git and serves each person and each AI agent exactly the folders they're allowed to see, composed into one working tree. Self-hosted, auditable, and built so an agent can read and write your brain through the same permission model as a human.

> **Status:** pre-1.0, developed in the open.

## Quickstart

```bash
cp .env.example .env        # set BETTER_AUTH_SECRET + the two Postgres passwords
docker compose up -d        # postgres + migrate + app (:3000) + git-proxy (:3002)
```

Open <http://localhost:3000>. No paywall and no external services required: binary blobs fall back to local disk and billing is off by default.

## How it works

| Piece | What it is |
|---|---|
| **`apps/app`** | The product (Next.js): orgs, folders, per-folder access, the Brain explorer. |
| **`apps/git-proxy`** | The git data plane (Hono): git smart-HTTP with per-folder authorization. Every clone / push / read is authorized before a byte is served. |
| **`packages/core`** | Domain + application layer (DDD, hexagonal): pure, infra-free, fully tested. |
| **`packages/git`, `packages/db`** | Adapters: git over bare repos, and Postgres/Drizzle. |
| **`@monora-ai/connector`** (`packages/connector`) | CLI that composes your authorized folders into a local tree. |
| **`@monora-ai/mcp`** (`packages/mcp`) | MCP server, so your AI reads and searches the brain through the same permissions. |

A request never reaches a repo without passing the authorization chokepoint, and a token's scopes intersect the folder ACL (they never widen it).

## Develop

Node >= 22.12, pnpm 8.15.5 (corepack). Then:

```bash
pnpm install
pnpm -r typecheck && pnpm -r test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CLAUDE.md](./CLAUDE.md) (the architecture map and conventions - the repo is meant to be agent-operable).

## License

[Apache 2.0](./LICENSE). "Monora" and the Monora logo are trademarks of Dreamshot LLC.

---

Don't want to run it yourself? We offer a managed, hosted Monora - same product, we keep it running. See [monora.ai](https://monora.ai).
