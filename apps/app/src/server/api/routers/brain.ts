import { z } from "zod";
import { router, orgProcedure } from "@/server/api/trpc";
import { recordUserMemoryEvent } from "@monora/db";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

/**
 * The Brain explorer's read side. `orgProcedure` (any member) - the per-folder
 * ACL is enforced inside the use-case via `can(read)`, not by an org-role gate,
 * so this surface works for non-admins browsing what they're authorized for.
 */
export const brainRouter = router({
  /** Every folder in the org the caller can READ - the Drive listing for the
   *  explorer. A folder you can't read is absent (so a nested folder you weren't
   *  granted is invisible while you still see its authorized siblings/parent). */
  accessibleFolders: orgProcedure.query(async ({ ctx }) => {
    const res = await useCases.listAccessibleFolders({
      subject: { userId: ctx.user.id, orgId: ctx.orgId },
    });
    if (!res.ok) throw toTRPCError(res.error);
    return res.value;
  }),

  /** Immediate children at `path` inside a folder (= one bare git repo). */
  browseFolder: orgProcedure
    .input(
      z.object({
        folderId: z.string().uuid(),
        path: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const res = await useCases.browseFolder({
        subject: { userId: ctx.user.id, orgId: ctx.orgId },
        folderId: input.folderId,
        path: input.path,
      });
      if (!res.ok) throw toTRPCError(res.error);
      await recordUserMemoryEvent(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.user.id,
        eventType: "folder.browsed",
        metadata: {
          folderId: input.folderId,
          path: input.path ?? "",
          entryCount: res.value.length,
        },
      });
      return res.value;
    }),

  /** Read one file's content (for the viewer). `can(read)`-gated like browse. */
  readFile: orgProcedure
    .input(
      z.object({
        folderId: z.string().uuid(),
        path: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const res = await useCases.readBrainFile({
        subject: { userId: ctx.user.id, orgId: ctx.orgId },
        folderId: input.folderId,
        path: input.path,
      });
      if (!res.ok) throw toTRPCError(res.error);
      await recordUserMemoryEvent(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.user.id,
        eventType: "file.read",
        metadata: {
          folderId: input.folderId,
          path: res.value.path,
          truncated: res.value.truncated,
        },
      });
      return res.value;
    }),
});
