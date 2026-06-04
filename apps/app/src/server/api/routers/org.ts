import { z } from "zod";
import { desc } from "drizzle-orm";
import { router, orgProcedure } from "@/server/api/trpc";
import { brains, folders, auditLog } from "@/server/db/schema";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

export const orgRouter = router({
  /** Spaces (workspaces) in the active org. RLS scopes the rows. */
  listBrains: orgProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(brains).orderBy(desc(brains.createdAt));
  }),

  /** Folders (the per-repo units of access) in the active org. */
  listFolders: orgProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(folders).orderBy(desc(folders.createdAt));
  }),

  /** Recent audit entries for the active org. */
  recentActivity: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(input.limit);
    }),

  /** Create (or reuse) a brain. Thin: delegates to the use-case. */
  createBrain: orgProcedure
    .input(z.object({ name: z.string().min(1), slug: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.ensureBrain({
        orgId: ctx.orgId,
        name: input.name,
        slug: input.slug,
        ownerUserId: ctx.user.id,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return res.value;
    }),

  /** Create an empty folder = one bare git repo + its row. Pass `parentFolderId`
   *  to nest it under another folder (path derived, parent's access copied). */
  createFolder: orgProcedure
    .input(
      z.object({
        brainId: z.string().uuid(),
        parentFolderId: z.string().uuid().optional(),
        name: z.string().min(1),
        slug: z.string().min(1),
        path: z.string().min(1).optional(),
        defaultBranch: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.createFolder({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        ...input,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return res.value;
    }),
});
