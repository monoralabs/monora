# syntax=docker/dockerfile:1.7
#
# git-proxy (Hono) image. Runs the TypeScript entry directly with tsx (no build
# step). Build context is the MONOREPO ROOT (dev/):
#
#   docker build -f apps/git-proxy/Dockerfile -t monora-git-proxy .

FROM node:22.21.1-alpine
RUN apk add --no-cache libc6-compat git
# The bare repos in the shared /data/git volume can be owned by a different uid
# than this image's runtime user (they are created by the app/ingest/admin
# containers). git's dubious-ownership guard would then refuse receive-pack
# (push) with exit 128. The proxy is the only thing running git here, so trust
# the repo root for every user.
RUN git config --system --add safe.directory '*'
RUN corepack enable && corepack prepare pnpm@8.15.5 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

# Dependency layer: copy ONLY the workspace manifests + lockfile first, so
# `pnpm install` becomes a Docker layer the gha cache reuses across builds and
# only busts when a package.json or pnpm-lock.yaml changes - NOT on every source
# edit. git-proxy is rebuilt on every push touching apps/** or packages/**, so
# the old `COPY . .` before install re-installed the whole monorepo each time
# (~1m39s). pnpm resolves the whole workspace from manifests alone; source
# comes after.
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
# Install with dev deps present (tsx is a devDependency). Do this BEFORE setting
# NODE_ENV=production, otherwise pnpm would prune tsx.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now the source. Edits here bust from this layer down, but the install layer
# above stays a cache hit - the point of the split. git-proxy runs the TS
# source directly with tsx, so the workspace source (core/db/git) is needed.
COPY . .

ENV NODE_ENV=production \
    GIT_PROXY_PORT=3002 \
    GIT_ROOT=/data/git
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S monora \
    && mkdir -p /data/git && chown -R monora:nodejs /data
USER monora
WORKDIR /repo/apps/git-proxy
EXPOSE 3002
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
