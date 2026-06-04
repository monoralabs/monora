import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { TokenLookup } from "@monora/core";
import type { DB } from "../client";
import { accessTokens } from "../schema";
import { toAccessToken } from "./repositories";

/**
 * Cross-tenant token lookup for the proxy/MCP. Runs WITHOUT a tenant binding
 * (the caller doesn't know the org until the token resolves), so it must use a
 * connection allowed to read across orgs - the proxy's owner role. Pre-filters
 * revoked/expired in SQL; the use-case re-checks (defense in depth).
 */
export function makeTokenLookup(db: DB): TokenLookup {
  return {
    findActiveByPrefix: async (prefix) => {
      const now = new Date();
      const [row] = await db
        .select()
        .from(accessTokens)
        .where(
          and(
            eq(accessTokens.tokenPrefix, prefix),
            isNull(accessTokens.revokedAt),
            or(isNull(accessTokens.expiresAt), gt(accessTokens.expiresAt, now)),
          ),
        )
        .limit(1);
      return row ? toAccessToken(row) : null;
    },
    touchLastUsed: async (tokenId, at) => {
      await db
        .update(accessTokens)
        .set({ lastUsedAt: at })
        .where(eq(accessTokens.id, tokenId));
    },
  };
}
