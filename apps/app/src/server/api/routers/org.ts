import { z } from "zod";
import { desc, eq, isNull, isNotNull } from "drizzle-orm";
import { router, orgProcedure, orgAdminProcedure } from "@/server/api/trpc";
import { brains, folders, auditLog } from "@/server/db/schema";
import { recordUserMemoryEvent } from "@monora/db";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

export const orgRouter = router({
  /** Spaces (workspaces) in the active org. RLS scopes the rows. */
  listBrains: orgProcedure.query(async ({ ctx }) => {
    return ctx.db.select().from(brains).orderBy(desc(brains.createdAt));
  }),

  /** Folders (the per-repo units of access) in the active org. Archived folders
   *  (the trash) are hidden here - see `listArchivedFolders`. */
  listFolders: orgProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(folders)
      .where(isNull(folders.archivedAt))
      .orderBy(desc(folders.createdAt));
  }),

  /** The trash: archived (soft-deleted) folders, recoverable via `restoreFolder`.
   *  Listed straight from the table (RLS-scoped) so the view shows every
   *  archived folder in the org; restore itself is admin-gated. */
  listArchivedFolders: orgProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(folders)
      .where(isNotNull(folders.archivedAt))
      .orderBy(desc(folders.archivedAt));
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
      if (res.value.wasCreated) {
        await recordUserMemoryEvent(ctx.db, {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          eventType: "brain.created",
          metadata: {
            brainId: res.value.id,
            brainName: res.value.name,
            brainSlug: res.value.slug,
          },
        });
      }
      return {
        id: res.value.id,
        orgId: res.value.orgId,
        name: res.value.name,
        slug: res.value.slug,
        createdAt: res.value.createdAt,
      };
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
      await recordUserMemoryEvent(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.user.id,
        eventType: "folder.created",
        metadata: {
          brainId: res.value.brainId,
          folderId: res.value.id,
          folderName: res.value.name,
          path: res.value.path,
        },
      });
      return res.value;
    }),

  /** Soft-delete a folder (and its subtree) to the trash. Recoverable: the bare
   *  repo is kept, so `restoreFolder` brings it back with full history. Admin. */
  archiveFolder: orgAdminProcedure
    .input(z.object({ folderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [folder] = await ctx.db
        .select()
        .from(folders)
        .where(eq(folders.id, input.folderId))
        .limit(1);
      const res = await useCases.archiveFolder({
        orgId: ctx.orgId,
        folderId: input.folderId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      if (res.value.archived.length > 0) {
        await recordUserMemoryEvent(ctx.db, {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          eventType: "folder.archived",
          metadata: {
            folderId: input.folderId,
            folderName: folder?.name,
            path: folder?.path,
            affectedCount: res.value.archived.length,
          },
        });
      }
      return res.value;
    }),

  /** Bring an archived folder back from the trash. Admin. */
  restoreFolder: orgAdminProcedure
    .input(z.object({ folderId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [folder] = await ctx.db
        .select()
        .from(folders)
        .where(eq(folders.id, input.folderId))
        .limit(1);
      const res = await useCases.restoreFolder({
        orgId: ctx.orgId,
        folderId: input.folderId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      if (res.value.restored.length > 0) {
        await recordUserMemoryEvent(ctx.db, {
          orgId: ctx.orgId,
          userId: ctx.user.id,
          eventType: "folder.restored",
          metadata: {
            folderId: input.folderId,
            folderName: folder?.name,
            path: folder?.path,
            affectedCount: res.value.restored.length,
          },
        });
      }
      return res.value;
    }),
});
