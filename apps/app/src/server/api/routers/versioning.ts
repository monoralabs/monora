import { z } from "zod";
import { router, orgAdminProcedure } from "@/server/api/trpc";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

/**
 * Brain versioning: save / list / restore brain-wide snapshots (the rollback
 * safety net for agentic edits). Admin-only - restoring rewrites every folder's
 * branch, so it's a coarse org-role gate (`orgAdminProcedure`), like sharing.
 */
export const versioningRouter = router({
  /** Snapshots for a brain, newest first. */
  list: orgAdminProcedure
    .input(z.object({ brainId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const res = await useCases.listBrainSnapshots({
        orgId: ctx.orgId,
        brainId: input.brainId,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return res.value;
    }),

  /** Save the current state of a brain as a restorable version. */
  create: orgAdminProcedure
    .input(
      z.object({
        brainId: z.string().uuid(),
        label: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.createBrainSnapshot({
        orgId: ctx.orgId,
        brainId: input.brainId,
        label: input.label,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return res.value;
    }),

  /** Roll the brain back to a snapshot (auto-backs-up the current state first). */
  restore: orgAdminProcedure
    .input(z.object({ snapshotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.restoreBrainSnapshot({
        orgId: ctx.orgId,
        snapshotId: input.snapshotId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return res.value;
    }),
});
