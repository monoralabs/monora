import { eq } from "drizzle-orm";
import type { DB } from "../client";
import { member } from "../auth-schema";

/**
 * Resolve the orgs a user belongs to, from Better Auth's `member` table. This
 * is a cross-tenant lookup a user-scoped token needs (the read/write paths must
 * know every org the user can reach), so - like the brain->org resolver - it
 * must run UNFILTERED by org and relies on the owner DB role (RLS bypassed).
 * `member` is an auth table, not a tenant-scoped domain table, so there is no
 * per-org policy to satisfy here. Per-folder authorization is still enforced
 * afterwards via `can` on each resolved org.
 */
export function makeMemberships(db: DB) {
  return {
    async listOrgsForUser(userId: string): Promise<string[]> {
      const rows = await db
        .select({ orgId: member.organizationId })
        .from(member)
        .where(eq(member.userId, userId));
      return rows.map((r) => r.orgId);
    },
  };
}
