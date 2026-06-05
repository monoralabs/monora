import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { withTenant } from "@/server/db/tenant";
import { member } from "@/server/db/auth-schema";
import { isPlatformAdmin } from "@/server/authz/platform";

/**
 * Per-request context. The session comes from Better Auth; the active org is
 * whatever Better Auth's organization plugin stamped onto the session
 * (`activeOrganizationId`). We never trust a client-supplied org id.
 */
export async function createTRPCContext(opts: { headers: Headers }) {
  const session = await auth.api.getSession({ headers: opts.headers });
  // TEMP preview-only fallback (env-gated) so the dashboard renders demo data
  // without a real session. Never set MONORA_PREVIEW in prod.
  if (!session && process.env.MONORA_PREVIEW === "1") {
    return {
      session: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      user: { id: "user_preview", name: "Preview User", email: "preview@monora.local" } as any,
      orgId: "org_preview",
      db,
    };
  }
  return {
    session: session?.session ?? null,
    user: session?.user ?? null,
    orgId: session?.session.activeOrganizationId ?? null,
    db,
  };
}

type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires an authenticated user. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/**
 * Requires auth + an active organization on the session. Runs the WHOLE
 * resolver inside withTenant, so ctx.db is a tenant-bound transaction and every
 * query is RLS-scoped. This is the procedure to build tenant features on.
 *
 * Membership itself is enforced by Better Auth (the org plugin only sets
 * activeOrganizationId for orgs the user belongs to); RLS is defense in depth.
 */
export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.orgId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No active organization",
    });
  }
  const orgId = ctx.orgId;

  return withTenant(orgId, async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_user_id', ${ctx.user.id}, true)`,
    );
    return next({ ctx: { ...ctx, db: tx, orgId } });
  });
});

/**
 * Like orgProcedure, but also requires the caller to be an org owner/admin
 * (Better Auth member.role). Managing folder access and members is admin-only.
 * This is a coarse ORG-ROLE gate, distinct from the per-folder ACL (`can`).
 */
export const orgAdminProcedure = orgProcedure.use(async ({ ctx, next }) => {
  const [row] = await ctx.db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, ctx.orgId),
        eq(member.userId, ctx.user.id),
      ),
    )
    .limit(1);
  if (!row || (row.role !== "owner" && row.role !== "admin")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Org admin role required",
    });
  }
  return next({ ctx });
});

/**
 * Whole-platform admin (Monora staff). Distinct from orgAdminProcedure: this is
 * NOT scoped to a tenant - it reads global auth tables (user, organization,
 * subscription) across every org, so it does NOT run inside withTenant and
 * ctx.db stays the plain (RLS-restricted) connection. Those auth tables aren't
 * RLS-scoped, so cross-tenant reads work without owner creds. Authorization is
 * re-checked against the DB (`user.role`), never the session cookie.
 */
export const platformAdminProcedure = protectedProcedure.use(
  async ({ ctx, next }) => {
    if (!(await isPlatformAdmin(ctx.user.id))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Platform admin role required",
      });
    }
    return next({ ctx });
  },
);
