import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { makeDeviceFlows } from "@monora/db";
import { router, orgProcedure } from "@/server/api/trpc";
import { organization } from "@/server/db/auth-schema";

/**
 * Browser side of the connector's Device Authorization Grant. The CLI gets a
 * `user_code` from the proxy and the user confirms it here, in the org they're
 * signed into. Approving stamps the flow with this user + org; the proxy then
 * mints the actual token when the CLI polls. We never see or store the token.
 *
 * device_flows has no RLS (the flow starts anonymous), so these queries reach
 * it directly even though they run inside the tenant transaction.
 */
export const deviceRouter = router({
  // Validate a code before showing the approve button, and tell the user which
  // org they're about to connect (their active org).
  status: orgProcedure
    .input(z.object({ userCode: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const flows = makeDeviceFlows(ctx.db);
      const flow = await flows.findActiveByUserCode(
        normalizeCode(input.userCode),
        new Date(),
      );
      const [org] = await ctx.db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, ctx.orgId))
        .limit(1);
      return {
        valid: !!flow && flow.status === "pending",
        alreadyResolved: !!flow && flow.status !== "pending",
        orgName: org?.name ?? "your organization",
      };
    }),

  // Approve the flow: bind it to this user + active org. The CLI's next poll
  // will then receive a freshly minted token scoped to this org.
  approve: orgProcedure
    .input(z.object({ userCode: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const flows = makeDeviceFlows(ctx.db);
      const flow = await flows.findActiveByUserCode(
        normalizeCode(input.userCode),
        new Date(),
      );
      if (!flow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That code is invalid or has expired. Start again in your terminal.",
        });
      }
      if (flow.status !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That code was already used. Start again in your terminal.",
        });
      }
      const ok = await flows.approve(flow.id, {
        userId: ctx.user.id,
        orgId: ctx.orgId,
        at: new Date(),
      });
      if (!ok) {
        // Lost a race (claimed/denied between the read and the update).
        throw new TRPCError({
          code: "CONFLICT",
          message: "That code was already used. Start again in your terminal.",
        });
      }
      return { ok: true as const };
    }),
});

/** Accept codes with or without the dash, any case, trimmed. */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}
