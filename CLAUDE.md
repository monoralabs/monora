# dev/ - the code

Turborepo + pnpm monorepo. This is **what we build**; `../org/` is **what we decided** (vision, brand spec, landing copy). Code here implements decisions there. See `../CLAUDE.md` for the two-folder model and `README.md` for run/build commands.

> **Before building anything new, read [CONTRIBUTING.md](./CONTRIBUTING.md)** - especially "Before you build" (substantial features start as an issue, not a PR) and "Scope & philosophy" (the markdown-brain thesis and what's out of scope). Direction is agreed before implementation here.

## Layout

```
dev/
  apps/
    web/        # marketing landing - Astro 6 + Tailwind v4 + shadcn (static, monora.ai)
    app/        # product app - Next.js 16 (App Router) + Drizzle + Better Auth + tRPC
  packages/
    brand/      # the design system: tokens.css + theme.css + logo.svg (CSS-only, no JS)
```

## Golden rule: all UI comes from `@monora/brand`

**Never hardcode a color, font, radius, or shadow.** Everything is a brand token. Both apps import the brand package as CSS:

```css
/* apps/web/src/styles/global.css  and  apps/app/src/app/globals.css */
@import 'tailwindcss';
@import '@monora/brand/theme.css';
@import '@monora/brand/tokens.css';
```

- `@monora/brand` is `workspace:*` (local symlink, no build step - it's raw CSS).
- `tokens.css` = raw CSS custom properties (`--accent`, `--ink`, `--cream`, gradients...). It is a **byte-for-byte mirror of `../org/sales-development/brand/tokens.css`** - that file is the source of truth. If you change tokens, edit the `org/` copy first, then mirror it here.
- `theme.css` = Tailwind v4 `@theme inline {}` block that re-exposes those tokens as utilities (`bg-accent`, `text-muted-foreground`, `font-display`, `rounded-lg`, `animate-text-shimmer`), plus `:root`/`.dark` values, keyframes, and brand utility classes (`.text-gradient`, `.btn-gradient`, `.sweep`, `.horizon`, `.shadow-card`, `.section-padding`, `.container`). `theme.css` lives only here, not in `org/`.

So: write `className="bg-accent text-foreground font-display"`, not `style={{ color: '#E2613E' }}`. New brand token → add to `org/.../tokens.css`, mirror into `packages/brand/tokens.css`, then declare in `packages/brand/theme.css` (`@theme inline` + `:root`).

**Legibility rule (from brand.md):** amber `#F4A24C` is for fills/sun/sweeps only, never on text. Text gradients must use the dark `--grad-text` (coral→brick, `#EE6C4D`→`#C0392B`).

## Tailwind v4 - no config file

There is **no `tailwind.config.js`** anywhere. Tailwind v4 reads tokens from CSS (`@theme` in `packages/brand/theme.css`). `web` wires it via `@tailwindcss/vite`; `app` via `@tailwindcss/postcss`. Do not create a config file - customize tokens in the brand package.

## Commands (from `dev/`)

| Task | Command |
|---|---|
| Dev, all | `pnpm dev` |
| Web only | `pnpm web` (= `pnpm --filter @monora/web dev`) |
| App only | `pnpm --filter @monora/app dev` |
| Build / lint, all | `pnpm build` / `pnpm lint` |

- **Node >= 22.12** (Astro 6 hard requirement). `.nvmrc` pins 22.21.1; `mise.toml` sets node 22. pnpm is locked to `8.15.5` (corepack).
- Vite is pinned workspace-wide to `7.3.1` via root `pnpm.overrides` - don't add a conflicting version.

## apps/web (Astro static landing)

- Stack: Astro 6.1.1, Tailwind v4, React 19 islands, `motion/react` (NOT `framer-motion`), shadcn `new-york`. Output is fully static - no API routes, no backend. Auth forms are UI shells only.
- Fonts (Playfair Display / Inter / Space Mono) come from `astro.config.mjs` via Google font provider, exposed as `--font-playfair` / `--font-inter` / `--font-space-mono`.
- Structure: `src/pages/*.astro` are thin wrappers around `DefaultLayout`/`AuthLayout` that mount React section components from `src/components/sections/` with `client:load|idle|visible`. `src/components/ui/` = shadcn primitives (excluded from eslint). Path alias `@/` → `src/`.
- Dark mode is **class-based** (`dark` on `<html>`, set by `ThemeToggle` + inline script in `BaseHead.astro`), not `prefers-color-scheme`.
- The homepage copy is applied from `../org/sales-development/landing-content.md`; the hero should match `../org/sales-development/brand/improved-hero.html`.
- This app was scaffolded from the "Kinto" shadcnblocks template - **stale template strings remain** (`Kinto`, `hello@kinto.app`, `kinto-astro-template.vercel.app` in `src/consts.ts`, `src/lib/constants.ts`, and several page `<title>`s). Fix before production.
- Add shadcn component: `pnpm --filter @monora/web dlx shadcn@latest add <name>`. Blocks from shadcnblocks need `SHADCNBLOCKS_API_KEY`.

## apps/app (Next.js product app)

The real product. Multi-tenant from day one. Built so far; much is still stubbed.

- Stack: Next.js 16.2 (App Router, Turbopack), React 19, Drizzle 0.45 + Postgres, Better Auth 1.6 (org + magicLink + emailOTP + admin + Stripe plugins), tRPC 11, Tailwind v4, Zod 4. `output: 'standalone'` for Hetzner/Docker.
- **Tenancy is the whole point.** Better Auth's organization plugin stamps `session.activeOrganizationId`; the server NEVER trusts a client-supplied org id. Domain tables (`brains`, `folders`, `folder_access`, `audit_log`) have Postgres **RLS** keyed on `org_id`. (A `brain` is the DB term for a workspace; the UI also calls it a Brain. It was renamed from `spaces` in Phase 4.5.)
- **Two Postgres roles / two URLs:** `DATABASE_URL` (role `app_user`, RLS enforced - the running app) vs `DATABASE_URL_OWNER` (role `monora_owner`, bypasses RLS - migrations only). Using the owner URL at runtime silently bypasses all tenant isolation.
- **`withTenant(orgId, fn)`** (`src/server/db/tenant.ts`) opens a transaction and `SET LOCAL app.current_org_id`. **Never query domain tables outside it** - RLS returns zero rows (not an error) when unset, so forgetting it = silently empty results.
- **`orgProcedure`** (tRPC) runs the whole resolver inside `withTenant`, so `ctx.db` inside it is already a tenant-bound transaction. Procedure tiers: `publicProcedure` / `protectedProcedure` (needs user) / `orgProcedure` (needs orgId) / `orgAdminProcedure` (org owner/admin). Routers: `org` (`listBrains`, `listFolders`, `createBrain`, `createFolder`, `recentActivity`), `brain` (`browseFolder`), `access`, `members`, `onboarding`, `tokens`.
- **Authz: swappable `can(subject, action, folderId)`** interface in `src/server/authz/index.ts`. The unit of access is the **folder**. Current impl `PostgresAuthz` queries `folder_access`; intended future backend is OpenFGA.
- **`auth-schema.ts` is generated** by `pnpm auth:generate` - don't hand-edit. After a Better Auth plugin/version change: regenerate, then `db:generate` + `db:migrate`.
- Local run: `cd apps/app && docker compose up -d` (Postgres on **:5433**, not 5432), `pnpm db:migrate`, then `pnpm --filter @monora/app dev` (port 3000). Required env in mise: `DATABASE_URL`, `DATABASE_URL_OWNER`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`. In dev, magic-link/OTP/email just `console.log`.
- **Routes:** the authenticated app has **no `/dashboard` prefix** (Phase 4.5) - pages live in the route group `src/app/(app)/` and resolve at `/overview`, `/brains`, `/brains/[brainId]`, `/settings/*`. `/` is the sign-in. Phases 1-4 (data plane, git proxy, connector, ingest CLI) and 4.5 (Brain explorer) are built; the MCP gateway is Phase 5 (see `../org/product-development/roadmap/`).
- The two apps share `@monora/brand` (CSS) but **do not share React components** - `web` is Astro, `app` is Next.js, each has its own `src/components/ui/`.

## Env / secrets

`mise.local.toml` (gitignored, repo root) holds all secrets; `mise.toml` (tracked) only has non-secret defaults. App `db:*` and `dev` scripts prefix `mise exec --` to inject env - running bare `next dev` without mise will fail. `.env.example` in `apps/app` documents the keys.

## Voice & UI copy (the Monora voice)

Write product copy like **Lovable, but for company brains**: warm, plain, confident, second person. The onboarding is the reference - `apps/app/src/components/onboarding-stepper.tsx` and `settings/connect`. Match that tone everywhere in the app.

- **Lead with the benefit, not the mechanism.** "Bring your brain to your computer", not "compose your authorized folders into a local git tree".
- **No jargon in visible text.** Banned from copy: `git tree`, `compose`, `repository`, `MCP server`, `clone`, `write-back`, `wire`, `sync` (as a noun in prose), `token`. The command block can be technical; the words around it can't.
- **Our words:** say `your AI` (not "your agent"), `key` (not "token"), and keep `brain` - it's ours and it's friendly.
- **Short sentences, one idea per line.** Imperative for instructions ("Paste this into your terminal."). Cut hedge words.
- **Friendly, not cute.** "You're in." / "Done." beat "Awesome! 🎉". No exclamation spam, no emoji in product copy.
- **Punctuation:** hyphens, never em dashes (matches the global rule).

When in doubt, read a line out loud - if it sounds like a release note, rewrite it.

## Deploy gotcha

Commits use the GitHub noreply author (`43324374+javierjrueda@users.noreply.github.com`); no personal email enters history. Vercel's Hobby plan blocks deploys whose git author isn't a verified account email, so `apps/web` (the only Vercel-deployed app, and private-overlay) needs Vercel Pro or a reconnect to keep deploying. The product app + git-proxy deploy via GitHub Actions, not Vercel.
