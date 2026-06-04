import { eq } from "drizzle-orm";
import type { DB } from "../client";
import { brains } from "../schema";

// brains.id is a uuid column. A non-uuid brain id (a malformed repo path like
// `brain_does_not_exist/x.git`) can never match a row, and querying it raw makes
// Postgres throw "invalid input syntax for type uuid" - which bubbles out as a
// 500 instead of the proxy's uniform 401 denial, a weak existence oracle. Treat
// a non-uuid id as "no such brain" so the denial stays clean and uniform.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve which org(s) may currently reach a brain, by brain id. This is the
 * one cross-tenant lookup the git proxy makes: the repo name is keyed by brain
 * id (org-independent), so the tenant is derived here rather than trusted from
 * the URL. It must run UNFILTERED by org (the caller doesn't know the org yet),
 * so it relies on the proxy's owner DB role (RLS bypassed); explicit per-org
 * filtering happens afterwards on the resolved org.
 *
 * Today a brain has a single owning org (`brains.org_id`), so this returns at
 * most one id. It is the seam where brain sharing (a brain reachable by several
 * orgs via a join table) plugs in later, without touching the proxy or the
 * authorization chokepoint.
 */
export function makeBrainOrgResolver(db: DB) {
  return async (brainId: string): Promise<string[]> => {
    if (!UUID_RE.test(brainId)) return [];
    const rows = await db
      .select({ orgId: brains.orgId })
      .from(brains)
      .where(eq(brains.id, brainId))
      .limit(1);
    return rows.map((r) => r.orgId);
  };
}
