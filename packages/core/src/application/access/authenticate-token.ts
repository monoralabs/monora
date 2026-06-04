import { asResult, DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { Clock } from "../../shared/ports";
import type { TokenHasher } from "../../domain/access/token-hasher";
import type { TokenLookup } from "../../domain/access/token-repository";
import { isTokenActive } from "../../domain/access/access-token";

export interface AuthenticateTokenDeps {
  tokens: TokenLookup;
  hasher: TokenHasher;
  clock: Clock;
}

export interface AuthenticatedSubject {
  userId: string;
  orgId: string;
  scopes: string[] | null;
}

/** Resolve a raw token to its principal, for surfaces that authenticate before
 *  they know the org (the manifest endpoint, the MCP gateway). Folder-level
 *  authorization is still the caller's job via `can`. Uniform denial. */
export function authenticateToken(deps: AuthenticateTokenDeps) {
  return (
    rawToken: string | null,
  ): Promise<Result<AuthenticatedSubject, DomainError>> =>
    asResult(async () => {
      if (!rawToken) throw DomainError.forbidden("access denied");
      const now = deps.clock.now();
      const token = await deps.tokens.findActiveByPrefix(
        deps.hasher.parsePrefix(rawToken),
      );
      const valid =
        token !== null &&
        isTokenActive(token, now) &&
        (await deps.hasher.verify(rawToken, token.hashedSecret));
      if (!token || !valid) throw DomainError.forbidden("access denied");

      await deps.tokens.touchLastUsed(token.id, now);
      return {
        userId: token.subjectId,
        orgId: token.orgId,
        scopes: token.scopes,
      };
    });
}
