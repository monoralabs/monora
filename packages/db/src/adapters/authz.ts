import { and, eq } from "drizzle-orm";
import type { Authz, Permission, Subject } from "@monora/core";
import { maxPermission, permissionSatisfies } from "@monora/core";
import type { DB } from "../client";
import { makeWithTenant } from "../tenant";
import { folderAccess, groupGrants, groupMembers } from "../schema";

/**
 * The Postgres-backed authz adapter. Effective permission on a folder is the
 * MAX of two sources, unioned here so every read path (manifest, git proxy,
 * browse, search) is group-aware through the one `Authz` port:
 *   - the subject's DIRECT grant (folder_access), and
 *   - every GROUP grant (group_grants) for a group the subject belongs to.
 *
 * A direct grant or a group can only ADD permission, never subtract it (no deny
 * overrides) - so "highest wins" is just the max over all the rows that apply.
 * Swap this one factory for OpenFGA when the matrix grows; no call site changes.
 */
export function makePostgresAuthz(db: DB): Authz {
  const withTenant = makeWithTenant(db);

  const levelFor = (subject: Subject, folderId: string) =>
    withTenant(subject.orgId, async (tx): Promise<Permission | null> => {
      const direct = await tx
        .select({ permission: folderAccess.permission })
        .from(folderAccess)
        .where(
          and(
            eq(folderAccess.folderId, folderId),
            eq(folderAccess.userId, subject.userId),
            eq(folderAccess.orgId, subject.orgId),
          ),
        );

      const viaGroup = await tx
        .select({ permission: groupGrants.permission })
        .from(groupGrants)
        .innerJoin(groupMembers, eq(groupMembers.groupId, groupGrants.groupId))
        .where(
          and(
            eq(groupGrants.folderId, folderId),
            eq(groupMembers.userId, subject.userId),
            eq(groupGrants.orgId, subject.orgId),
          ),
        );

      const perms = [...direct, ...viaGroup].map(
        (r) => r.permission as Permission,
      );
      return perms.length === 0 ? null : perms.reduce(maxPermission);
    });

  return {
    levelFor,
    can: async (subject, action, folderId) => {
      const held = await levelFor(subject, folderId);
      return held ? permissionSatisfies(held, action) : false;
    },
  };
}
