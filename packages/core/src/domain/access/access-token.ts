/** A credential a principal (user or agent) presents to the git proxy / MCP.
 *  The plaintext is shown once at issue; only a hash + a public prefix (for
 *  lookup) are stored. `scopes` optionally restricts an agent token to a set of
 *  folder ids (Phase 5); null = no extra restriction beyond the subject's ACL. */
export type SubjectType = "user" | "agent";

export interface AccessToken {
  readonly id: string;
  readonly orgId: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly hashedSecret: string;
  readonly scopes: string[] | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Not revoked and not past expiry. */
export function isTokenActive(t: AccessToken, now: Date): boolean {
  if (t.revokedAt) return false;
  if (t.expiresAt && t.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/** True if the token is allowed to reach this folder. Phase 2: a token with no
 *  scopes can reach anything its subject is authorized for; a scoped token must
 *  also list the folder. Final say is always the ACL (`can`), checked by the
 *  caller - this is only the token-scope intersection. */
export function scopeAllowsFolder(
  scopes: string[] | null,
  folderId: string,
): boolean {
  if (scopes === null) return true;
  return scopes.includes(folderId);
}

export function tokenScopeAllows(t: AccessToken, folderId: string): boolean {
  return scopeAllowsFolder(t.scopes, folderId);
}
