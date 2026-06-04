import type { AccessToken } from "./access-token";

/**
 * Tenant-bound token writes (issuing / listing / revoking within an org). Part
 * of the UnitOfWork repositories bundle.
 */
export interface TokenRepository {
  add(token: AccessToken): Promise<void>;
  listBySubject(subjectId: string): Promise<AccessToken[]>;
  revoke(tokenId: string, at: Date): Promise<void>;
}

/**
 * Cross-tenant token lookup for the proxy/MCP, which authenticate a raw token
 * BEFORE they know the org. Implemented against a connection that can read
 * across orgs (the proxy's owner role); never expose this to the app's
 * tenant-scoped surfaces.
 */
export interface TokenLookup {
  findActiveByPrefix(prefix: string): Promise<AccessToken | null>;
  touchLastUsed(tokenId: string, at: Date): Promise<void>;
}
