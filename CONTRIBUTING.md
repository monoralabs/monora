# Contributing to Monora

Thanks for your interest. Monora is pre-1.0 and developed in the open.

## Before you build (start here)

Monora has an opinionated scope and philosophy (see [Scope & philosophy](#scope--philosophy)). To save everyone's time - yours most of all - **propose before you build.**

- **Small changes go straight to a PR:** bug fixes, docs, tests, dependency bumps, small self-contained improvements.
- **Substantial changes start as an issue first** (use the _Feature request_ template) and wait for a maintainer 👍 on the direction before writing code. "Substantial" means: a new feature or user-facing surface, a new package or dependency, a schema / RLS / auth change, or anything that touches the product's philosophy. A large PR that lands with no prior agreed issue may be asked to restart as a proposal - not because the code is bad, but because **direction is agreed before implementation here.**

This is standard open-source hygiene (propose → agree → build) and it protects your effort as much as the project's coherence.

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

## Scope & philosophy

Monora's thesis is a **markdown + code + skills brain**: your knowledge lives as human-readable, git-versioned files you own - the opposite of an opaque vector/graph store. Keep that line in mind when proposing memory, search, or "AI context" features:

- A **derived index** over the markdown (e.g. to help find things faster) that points back to the files as the source of truth - plausibly in scope. Propose it first.
- A store that **becomes** the brain / source of truth (a vector or graph DB the files are secondary to) - against the thesis, out of scope for core. Explore it as an experiment in a fork or behind a flag, not as a core PR.

If you're unsure which side of that line your idea is on, open an issue and ask.
