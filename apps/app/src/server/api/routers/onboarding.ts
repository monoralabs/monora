import { eq } from "drizzle-orm";
import { router, orgProcedure } from "@/server/api/trpc";
import { accessTokens } from "@/server/db/schema";

/**
 * Onboarding state for the signed-in user, derived (not a separate flag) from
 * the DB: you're "done" once a token of yours has actually been used - i.e. an
 * agent connected and pulled/read. `last_used_at` is stamped on every
 * authorized request, so it is our persisted completion signal.
 */
export const onboardingRouter = router({
  status: orgProcedure.query(async ({ ctx }) => {
    const toks = await ctx.db
      .select({ lastUsedAt: accessTokens.lastUsedAt })
      .from(accessTokens)
      .where(eq(accessTokens.subjectId, ctx.user.id));
    return {
      hasKey: toks.length > 0,
      completed: toks.some((t) => t.lastUsedAt !== null),
    };
  }),
});
