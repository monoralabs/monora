/**
 * Which orgs a user belongs to - the one cross-tenant lookup the read (manifest)
 * and write (git push) paths make for a user-scoped token. A personal "user"
 * token reaches every org the user is a member of, so its org set is resolved
 * here rather than baked into the token (the token's own `orgId` is only its
 * home/issuing org, used for storage and audit).
 *
 * It spans tenants, so the adapter runs RLS-free (the owner DB role) - exactly
 * like the brain->org resolver. It is NEVER the final authorization: every
 * folder still passes the per-folder `can` check on its resolved org.
 */
export interface Memberships {
  listOrgsForUser(userId: string): Promise<string[]>;
}
