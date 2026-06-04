/**
 * Pure platform-admin role helpers - safe to import from client OR server (no
 * "server-only", no DB). The authoritative DB-backed check lives in
 * @/server/authz/platform (server-only); this is just string logic shared with
 * the UI (e.g. badging a user as admin in a table).
 *
 * Better Auth's admin plugin stores roles as a comma-separated string in
 * `user.role`, so "admin" is membership in that list, not equality.
 */
export const PLATFORM_ADMIN_ROLE = "admin";

export function roleHasPlatformAdmin(role: string | null | undefined): boolean {
  if (!role) return false;
  return role
    .split(",")
    .map((r) => r.trim())
    .includes(PLATFORM_ADMIN_ROLE);
}
