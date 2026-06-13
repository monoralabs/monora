import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { router, orgAdminProcedure } from "@/server/api/trpc";
import { accessGroups, groupGrants, groupMembers, folders } from "@/server/db/schema";
import { user } from "@/server/db/auth-schema";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

const permission = z.enum(["read", "write", "admin"]);

/** Named groups: a reusable bundle of folder grants you assign people to.
 *  Effective access = MAX(direct grant, every group the user is in). Admin-only.
 *  All reads are RLS-scoped to the active org, so a groupId from another org
 *  simply returns nothing. */
export const groupsRouter = router({
  /** Every group in the org with member + folder-grant counts. */
  list: orgAdminProcedure.query(async ({ ctx }) => {
    const res = await useCases.listGroups({ orgId: ctx.orgId });
    if (!res.ok) throw toTRPCError(res.error);
    return res.value;
  }),

  /** The members of one group (name/email for the management UI). */
  membersOf: orgAdminProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          userId: groupMembers.userId,
          name: user.name,
          email: user.email,
        })
        .from(groupMembers)
        .innerJoin(user, eq(user.id, groupMembers.userId))
        .where(
          and(
            eq(groupMembers.groupId, input.groupId),
            eq(groupMembers.orgId, ctx.orgId),
          ),
        );
    }),

  /** The folders one group grants, with the folder's name/path for display. */
  grantsOf: orgAdminProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          folderId: groupGrants.folderId,
          permission: groupGrants.permission,
          folderName: folders.name,
          folderPath: folders.path,
          brainId: folders.brainId,
        })
        .from(groupGrants)
        .innerJoin(folders, eq(folders.id, groupGrants.folderId))
        .where(
          and(
            eq(groupGrants.groupId, input.groupId),
            eq(groupGrants.orgId, ctx.orgId),
          ),
        );
    }),

  create: orgAdminProcedure
    .input(z.object({ name: z.string().min(1), slug: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.createGroup({
        orgId: ctx.orgId,
        name: input.name,
        slug: input.slug,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return res.value;
    }),

  rename: orgAdminProcedure
    .input(z.object({ groupId: z.string().uuid(), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.renameGroup({
        orgId: ctx.orgId,
        groupId: input.groupId,
        name: input.name,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),

  delete: orgAdminProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.deleteGroup({
        orgId: ctx.orgId,
        groupId: input.groupId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),

  addMember: orgAdminProcedure
    .input(z.object({ groupId: z.string().uuid(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.addGroupMember({
        orgId: ctx.orgId,
        groupId: input.groupId,
        userId: input.userId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),

  removeMember: orgAdminProcedure
    .input(z.object({ groupId: z.string().uuid(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.removeGroupMember({
        orgId: ctx.orgId,
        groupId: input.groupId,
        userId: input.userId,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),

  grantFolder: orgAdminProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        folderId: z.string().uuid(),
        permission,
        /** Apply to this folder and every subfolder currently under it. */
        includeDescendants: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.grantGroupAccess({
        orgId: ctx.orgId,
        groupId: input.groupId,
        folderId: input.folderId,
        permission: input.permission,
        includeDescendants: input.includeDescendants,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),

  revokeFolder: orgAdminProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        folderId: z.string().uuid(),
        includeDescendants: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.revokeGroupAccess({
        orgId: ctx.orgId,
        groupId: input.groupId,
        folderId: input.folderId,
        includeDescendants: input.includeDescendants,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),
});
