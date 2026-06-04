import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { router, orgProcedure } from "@/server/api/trpc";
import { accessTokens } from "@/server/db/schema";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

/**
 * Connector/MCP credentials for the signed-in user. The plaintext secret is
 * returned by `issue` exactly ONCE; `list` never exposes the hash. (Phase 4
 * adds admin issuing on behalf of other members.)
 */
export const tokensRouter = router({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: accessTokens.id,
        name: accessTokens.name,
        tokenPrefix: accessTokens.tokenPrefix,
        createdAt: accessTokens.createdAt,
        lastUsedAt: accessTokens.lastUsedAt,
        expiresAt: accessTokens.expiresAt,
        revokedAt: accessTokens.revokedAt,
      })
      .from(accessTokens)
      .where(eq(accessTokens.subjectId, ctx.user.id))
      .orderBy(desc(accessTokens.createdAt));
  }),

  issue: orgProcedure
    // Name is optional - we don't make the user think one up. A dated default
    // keeps the list legible.
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const name =
        input?.name?.trim() ||
        `Key ${new Date().toISOString().slice(0, 10)}`;
      const res = await useCases.issueToken({
        orgId: ctx.orgId,
        subjectType: "user",
        subjectId: ctx.user.id,
        name,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      // Plaintext shown once; never persisted in clear.
      return {
        id: res.value.token.id,
        name: res.value.token.name,
        plaintext: res.value.plaintext,
      };
    }),

  revoke: orgProcedure
    .input(z.object({ tokenId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // A user may only revoke their own token; ownership check via the row.
      const [row] = await ctx.db
        .select({ subjectId: accessTokens.subjectId })
        .from(accessTokens)
        .where(
          and(
            eq(accessTokens.id, input.tokenId),
            eq(accessTokens.subjectId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!row) return { ok: false as const };
      const res = await useCases.revokeToken({
        orgId: ctx.orgId,
        tokenId: input.tokenId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),
});
