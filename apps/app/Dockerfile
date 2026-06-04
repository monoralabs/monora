# syntax=docker/dockerfile:1.7
#
# Next.js (standalone) image for @monora/app. The build context is the MONOREPO
# ROOT (dev/), because the app depends on workspace packages and the pnpm lock.
#
#   docker build -f apps/app/Dockerfile -t monora-app .
#
# Stages: base -> builder (install + next build) -> runner (slim standalone).

FROM node:22.21.1-alpine AS base
# libc6-compat: some prebuilt binaries (next/swc) expect glibc symbols on Alpine.
# git: the app + the admin/ingest CLIs shell out to `git` (packages/git) to read,
# browse, and snapshot brain repos - needed in builder (migrate/admin) and runner.
RUN apk add --no-cache libc6-compat git
RUN corepack enable && corepack prepare pnpm@8.15.5 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

# ---------- builder: install deps and build the app ----------
FROM base AS builder
# Dependency layer: copy ONLY the workspace manifests + lockfile first, so
# `pnpm install` becomes a Docker layer the gha cache reuses across builds and
# only busts when a package.json or pnpm-lock.yaml changes - NOT on every source
# edit (the old `COPY . .` before install re-linked every dependency each build).
# pnpm resolves the whole workspace from manifests alone; source comes after.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
COPY apps/app/package.json apps/app/
COPY apps/web/package.json apps/web/
COPY apps/git-proxy/package.json apps/git-proxy/
COPY packages/brand/package.json packages/brand/
COPY packages/connector/package.json packages/connector/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/git/package.json packages/git/
COPY packages/ingest/package.json packages/ingest/
COPY packages/mcp/package.json packages/mcp/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now the source. Edits here bust from this layer down, but the install layer
# above stays a cache hit - the point of the split.
COPY . .

# Build-time env. src/env.ts validates with zod AT IMPORT, and some modules
# instantiate clients at load (new Stripe(...)), so these must be PRESENT and
# well-formed - but they are throwaway. Real secrets are injected at runtime.
# NEXT_PUBLIC_* is the exception: it is inlined into the client bundle now, so
# the app URL must be the real production value here.
ARG NEXT_PUBLIC_APP_URL=https://app.monora.ai
# The git data-plane host the dashboard hands to the connector / MCP setup
# commands. Inlined into the client bundle, so it must be the real value here.
ARG NEXT_PUBLIC_GIT_PROXY_URL=https://git.monora.ai
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_GIT_PROXY_URL=${NEXT_PUBLIC_GIT_PROXY_URL} \
    BETTER_AUTH_URL=${NEXT_PUBLIC_APP_URL} \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build_time_placeholder_secret_0123456789 \
    RESEND_API_KEY=re_build_placeholder \
    STRIPE_SECRET_KEY=sk_test_build_placeholder
# Mount Next's compiler cache so builds compile incrementally instead of from
# scratch (the bulk of build time). The gha runner does NOT persist RUN cache
# mounts on its own - the deploy workflow's buildkit-cache-dance step saves and
# restores /repo/apps/app/.next/cache across runs.
RUN --mount=type=cache,id=next-cache,target=/repo/apps/app/.next/cache \
    pnpm --filter @monora/app build

# ---------- runner: minimal standalone server ----------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The app shells out to `git` (packages/git) to read/browse brain repos.
RUN apk add --no-cache git
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nextjs

# Standalone output. With outputFileTracingRoot=<repo root> the layout is
# /repo/apps/app/server.js plus a shared /repo/node_modules.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/app/.next/static ./apps/app/.next/static
# Static assets (favicon, etc.) - standalone output does NOT include public/.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/app/public ./apps/app/public
# Default-brain guide content, ingested into every org's "Monora" brain on create.
COPY --from=builder --chown=nextjs:nodejs /repo/seed/default-brain ./seed/default-brain
ENV DEFAULT_BRAIN_SEED_DIR=/repo/seed/default-brain

USER nextjs
EXPOSE 3000
CMD ["node", "apps/app/server.js"]
