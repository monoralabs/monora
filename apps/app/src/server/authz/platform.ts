import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { user } from "@/server/db/auth-schema";
import {
  PLATFORM_ADMIN_ROLE,
  roleHasPlatformAdmin,
} from "@/lib/platform-role";

export { PLATFORM_ADMIN_ROLE, roleHasPlatformAdmin };

/**
 * Platform (whole-app) admin authorization. This is DISTINCT from the org-scoped
 * `member.role` ("owner"/"admin" within one organization): a platform admin is a
 * Monora staff superuser who can see every user and org across all tenants.
 *
 * It lives on the global `user.role` text column (added by Better Auth's `admin`
 * plugin). Better Auth allows multiple comma-separated roles, so we split and
 * look for "admin" rather than comparing the whole string.
 *
 * Bootstrap the first admin with the CLI: `pnpm --filter @monora/app admin
 * user:role --email you@monora.ai --role admin` (owner role, bypasses RLS).
 */

/**
 * Authoritative check, read straight from the DB (never trust the session cookie
 * for a privileged gate - it can be up to 3 min stale, and a demoted admin must
 * lose access immediately). The `user` table is not RLS-scoped, so the app_user
 * connection reads it fine.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return roleHasPlatformAdmin(row?.role);
}
