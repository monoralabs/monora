import "server-only";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { sql, eq, asc, desc, inArray } from "drizzle-orm";
import { router, platformAdminProcedure } from "@/server/api/trpc";
import {
  user,
  organization,
  member,
  subscription,
} from "@/server/db/auth-schema";
import { db } from "@/server/db";
import { withTenant } from "@/server/db/tenant";
import { brains, folders } from "@/server/db/schema";

/** Subscription statuses that count as "paying / usable" (mirrors billing.ts). */
const ACTIVE_STATUSES = ["active", "trialing", "past_due"];

const WINDOW_DAYS = 30;

type DayPoint = { date: string; count: number };

/** Pad a sparse [{day,count}] result into a continuous WINDOW_DAYS series
 *  ending today, so the client can render a chart without gap logic. */
function fillDaily(rows: { day: string; count: number }[]): DayPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  const out: DayPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}

/**
 * Platform-admin (Monora staff) data: cross-tenant metrics, users, orgs. Every
 * procedure is platformAdminProcedure (global `user.role` gate). All reads hit
 * non-RLS auth tables, so they see every tenant.
 */
export const adminRouter = router({
  /** Headline counters + 30-day signup/org growth + subscription mix. */
  metrics: platformAdminProcedure.query(async ({ ctx }) => {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (WINDOW_DAYS - 1));

    const [
      totalUsersRows,
      verifiedUsersRows,
      totalOrgsRows,
      totalMembersRows,
      activeSubscriptionsRows,
      newUsersRows,
      newOrgsRows,
      signupRows,
      orgRows,
      planRows,
    ] = await Promise.all([
      ctx.db.select({ totalUsers: sql<number>`count(*)::int` }).from(user),
      ctx.db
        .select({ verifiedUsers: sql<number>`count(*)::int` })
        .from(user)
        .where(eq(user.emailVerified, true)),
      ctx.db
        .select({ totalOrgs: sql<number>`count(*)::int` })
        .from(organization),
      ctx.db.select({ totalMembers: sql<number>`count(*)::int` }).from(member),
      ctx.db
        .select({ activeSubscriptions: sql<number>`count(*)::int` })
        .from(subscription)
        .where(inArray(subscription.status, ACTIVE_STATUSES)),
      ctx.db
        .select({ newUsers: sql<number>`count(*)::int` })
        .from(user)
        .where(sql`${user.createdAt} >= ${since}`),
      ctx.db
        .select({ newOrgs: sql<number>`count(*)::int` })
        .from(organization)
        .where(sql`${organization.createdAt} >= ${since}`),
      ctx.db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${user.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(user)
        .where(sql`${user.createdAt} >= ${since}`)
        .groupBy(sql`date_trunc('day', ${user.createdAt})`),
      ctx.db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${organization.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(organization)
        .where(sql`${organization.createdAt} >= ${since}`)
        .groupBy(sql`date_trunc('day', ${organization.createdAt})`),
      ctx.db
        .select({
          plan: subscription.plan,
          status: subscription.status,
          count: sql<number>`count(*)::int`,
        })
        .from(subscription)
        .groupBy(subscription.plan, subscription.status),
    ]);

    return {
      windowDays: WINDOW_DAYS,
      totals: {
        users: totalUsersRows[0]?.totalUsers ?? 0,
        verifiedUsers: verifiedUsersRows[0]?.verifiedUsers ?? 0,
        orgs: totalOrgsRows[0]?.totalOrgs ?? 0,
        members: totalMembersRows[0]?.totalMembers ?? 0,
        activeSubscriptions:
          activeSubscriptionsRows[0]?.activeSubscriptions ?? 0,
        newUsers: newUsersRows[0]?.newUsers ?? 0,
        newOrgs: newOrgsRows[0]?.newOrgs ?? 0,
      },
      signupsByDay: fillDaily(signupRows),
      orgsByDay: fillDaily(orgRows),
      plans: planRows,
    };
  }),

  /** Every user, newest first, with their org-membership count. */
  listUsers: platformAdminProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        banned: user.banned,
        createdAt: user.createdAt,
        orgCount: sql<number>`count(distinct ${member.organizationId})::int`,
      })
      .from(user)
      .leftJoin(member, eq(member.userId, user.id))
      .groupBy(user.id)
      .orderBy(desc(user.createdAt));
  }),

  /** Every organization, newest first, with member count + creator. */
  listOrgs: platformAdminProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: organization.createdAt,
        memberCount: sql<number>`count(distinct ${member.id})::int`,
      })
      .from(organization)
      .leftJoin(member, eq(member.organizationId, organization.id))
      .groupBy(organization.id)
      .orderBy(desc(organization.createdAt));
  }),

  /**
   * Every brain across every tenant. Brains ARE RLS-scoped, so instead of
   * bypassing RLS (owner creds) we enumerate orgs and read each tenant inside
   * withTenant - the sanctioned path. N small transactions; the admin dashboard
   * is low-traffic. Tenant isolation stays fully intact.
   */
  listBrains: platformAdminProcedure.query(async () => {
    const orgs = await db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      })
      .from(organization);

    const perOrg = await Promise.all(
      orgs.map((o) =>
        withTenant(o.id, async (tx) => {
          const rows = await tx
            .select({
              id: brains.id,
              name: brains.name,
              slug: brains.slug,
              createdAt: brains.createdAt,
              folderCount: sql<number>`count(distinct ${folders.id})::int`,
            })
            .from(brains)
            .leftJoin(folders, eq(folders.brainId, brains.id))
            .groupBy(brains.id)
            .orderBy(desc(brains.createdAt));
          return rows.map((r) => ({
            ...r,
            orgId: o.id,
            orgName: o.name,
            orgSlug: o.slug,
          }));
        }),
      ),
    );

    return perOrg
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }),

  /**
   * "Enter" a single brain (cross-tenant): its metadata + folder tree, read
   * only. We don't know the owning org from the id alone (RLS), so we locate it
   * by scanning orgs and binding withTenant; first hit wins, then early-return.
   * Folder STRUCTURE only - file contents are intentionally not exposed here.
   */
  getBrain: platformAdminProcedure
    .input(z.object({ brainId: z.string().uuid() }))
    .query(async ({ input }) => {
      const orgs = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        })
        .from(organization);

      for (const o of orgs) {
        const found = await withTenant(o.id, async (tx) => {
          const [b] = await tx
            .select()
            .from(brains)
            .where(eq(brains.id, input.brainId))
            .limit(1);
          if (!b) return null;
          const folderRows = await tx
            .select({
              id: folders.id,
              name: folders.name,
              slug: folders.slug,
              path: folders.path,
              parentFolderId: folders.parentFolderId,
              repoName: folders.repoName,
              defaultBranch: folders.defaultBranch,
              createdAt: folders.createdAt,
            })
            .from(folders)
            .where(eq(folders.brainId, b.id))
            .orderBy(asc(folders.path));
          return { brain: b, org: o, folders: folderRows };
        });
        if (found) return found;
      }

      throw new TRPCError({ code: "NOT_FOUND", message: "Brain not found" });
    }),
});
