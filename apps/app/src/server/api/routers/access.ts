import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { router, orgAdminProcedure } from "@/server/api/trpc";
import {
  folderAccess,
  accessGroups,
  groupGrants,
  groupMembers,
} from "@/server/db/schema";
import { member, user } from "@/server/db/auth-schema";
import { useCases } from "@/server/usecases";
import { toTRPCError } from "@/server/api/errors";

const permission = z.enum(["read", "write", "admin"]);

/** Folder-level access management. Admin-only (orgAdminProcedure). */
export const accessRouter = router({
  /** Every org member and their permission on this folder (null = no access). */
  membersForFolder: orgAdminProcedure
    .input(z.object({ folderId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          userId: member.userId,
          name: user.name,
          email: user.email,
          role: member.role,
          permission: folderAccess.permission,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .leftJoin(
          folderAccess,
          and(
            eq(folderAccess.userId, member.userId),
            eq(folderAccess.folderId, input.folderId),
          ),
        )
        .where(eq(member.organizationId, ctx.orgId));
    }),

  /** Groups that grant this folder (group-level), for the share menu's Groups
   *  section. Each row is a group + the permission it gives on this folder. */
  groupsForFolder: orgAdminProcedure
    .input(z.object({ folderId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          groupId: accessGroups.id,
          groupName: accessGroups.name,
          permission: groupGrants.permission,
        })
        .from(groupGrants)
        .innerJoin(accessGroups, eq(accessGroups.id, groupGrants.groupId))
        .where(
          and(
            eq(groupGrants.folderId, input.folderId),
            eq(groupGrants.orgId, ctx.orgId),
          ),
        );
    }),

  /** Per-user access this folder gets THROUGH a group (the "via <group>" origin
   *  shown next to a member). Lets the UI explain why someone can see a folder
   *  even with no direct grant - and why a direct revoke alone won't remove it. */
  memberGroupsForFolder: orgAdminProcedure
    .input(z.object({ folderId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          userId: groupMembers.userId,
          groupName: accessGroups.name,
          permission: groupGrants.permission,
        })
        .from(groupGrants)
        .innerJoin(groupMembers, eq(groupMembers.groupId, groupGrants.groupId))
        .innerJoin(accessGroups, eq(accessGroups.id, groupGrants.groupId))
        .where(
          and(
            eq(groupGrants.folderId, input.folderId),
            eq(groupGrants.orgId, ctx.orgId),
          ),
        );
    }),

  grant: orgAdminProcedure
    .input(
      z.object({
        folderId: z.string().uuid(),
        userId: z.string(),
        permission,
        /** Apply to this folder and every subfolder currently under it. */
        includeDescendants: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.grantAccess({
        orgId: ctx.orgId,
        folderId: input.folderId,
        userId: input.userId,
        permission: input.permission,
        includeDescendants: input.includeDescendants,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),

  revoke: orgAdminProcedure
    .input(
      z.object({
        folderId: z.string().uuid(),
        userId: z.string(),
        includeDescendants: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const res = await useCases.revokeAccess({
        orgId: ctx.orgId,
        folderId: input.folderId,
        userId: input.userId,
        includeDescendants: input.includeDescendants,
        actorId: ctx.user.id,
      });
      if (!res.ok) throw toTRPCError(res.error);
      return { ok: true as const };
    }),
});
