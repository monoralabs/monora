import { and, desc, eq } from "drizzle-orm";
import type {
  AccessGrant,
  AccessGroup,
  AccessToken,
  BrainSnapshot,
  Folder,
  GroupGrant,
  GroupMember,
  MountPath,
  Permission,
  Repositories,
  RepoName,
  Slug,
  Brain,
  SubjectType,
} from "@monora/core";
import {
  accessGroups,
  accessTokens,
  folderAccess,
  folders,
  groupGrants,
  groupMembers,
  brains,
  brainSnapshots,
  auditLog,
} from "../schema";
import type { Tx } from "../client";

/* Row -> aggregate mappers. The DB is the source of truth and already holds
 * validated values, so branded value objects are restored by cast (no
 * re-validation on the hot read path). */

type BrainRow = typeof brains.$inferSelect;
type FolderRow = typeof folders.$inferSelect;

function toBrain(r: BrainRow): Brain {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    slug: r.slug as Slug,
    createdAt: r.createdAt,
  };
}

function toFolder(r: FolderRow): Folder {
  return {
    id: r.id,
    orgId: r.orgId,
    brainId: r.brainId,
    parentFolderId: r.parentFolderId,
    name: r.name,
    slug: r.slug as Slug,
    path: r.path as MountPath,
    repoName: r.repoName as RepoName,
    defaultBranch: r.defaultBranch,
    source: r.source as Folder["source"],
    archivedAt: r.archivedAt,
    archivedBy: r.archivedBy,
    createdAt: r.createdAt,
  };
}

type GrantRow = typeof folderAccess.$inferSelect;

function toGrant(r: GrantRow): AccessGrant {
  return {
    orgId: r.orgId,
    folderId: r.folderId,
    userId: r.userId,
    permission: r.permission as Permission,
  };
}

type GroupRow = typeof accessGroups.$inferSelect;

function toGroup(r: GroupRow): AccessGroup {
  return {
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    slug: r.slug as Slug,
    createdAt: r.createdAt,
  };
}

type GroupGrantRow = typeof groupGrants.$inferSelect;

function toGroupGrant(r: GroupGrantRow): GroupGrant {
  return {
    orgId: r.orgId,
    groupId: r.groupId,
    folderId: r.folderId,
    permission: r.permission as Permission,
  };
}

type TokenRow = typeof accessTokens.$inferSelect;

export function toAccessToken(r: TokenRow): AccessToken {
  return {
    id: r.id,
    orgId: r.orgId,
    subjectType: r.subjectType as SubjectType,
    subjectId: r.subjectId,
    name: r.name,
    tokenPrefix: r.tokenPrefix,
    hashedSecret: r.hashedSecret,
    scopes: r.scopes ?? null,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  };
}

type SnapshotRow = typeof brainSnapshots.$inferSelect;

function toBrainSnapshot(r: SnapshotRow): BrainSnapshot {
  return {
    id: r.id,
    orgId: r.orgId,
    brainId: r.brainId,
    label: r.label,
    createdBy: r.createdBy,
    entries: r.entries,
    createdAt: r.createdAt,
  };
}

/**
 * Build the tenant-bound repository bundle. RLS already scopes rows to the
 * bound org, but we ALSO filter by orgId explicitly so the adapters stay
 * correct even under the owner role (which bypasses RLS) - e.g. the ingest CLI.
 */
export function makeRepositories(tx: Tx, orgId: string): Repositories {
  return {
    brains: {
      add: async (s) => {
        await tx.insert(brains).values({
          id: s.id,
          orgId: s.orgId,
          name: s.name,
          slug: s.slug,
          createdAt: s.createdAt,
        });
      },
      findById: async (id) => {
        const [r] = await tx
          .select()
          .from(brains)
          .where(and(eq(brains.id, id), eq(brains.orgId, orgId)))
          .limit(1);
        return r ? toBrain(r) : null;
      },
      findBySlug: async (slug) => {
        const [r] = await tx
          .select()
          .from(brains)
          .where(and(eq(brains.slug, slug), eq(brains.orgId, orgId)))
          .limit(1);
        return r ? toBrain(r) : null;
      },
      listByOrg: async () => {
        const rows = await tx
          .select()
          .from(brains)
          .where(eq(brains.orgId, orgId))
          .orderBy(desc(brains.createdAt));
        return rows.map(toBrain);
      },
    },

    folders: {
      add: async (f) => {
        await tx.insert(folders).values({
          id: f.id,
          orgId: f.orgId,
          brainId: f.brainId,
          parentFolderId: f.parentFolderId,
          name: f.name,
          slug: f.slug,
          path: f.path,
          repoName: f.repoName,
          defaultBranch: f.defaultBranch,
          source: f.source,
          archivedAt: f.archivedAt,
          archivedBy: f.archivedBy,
          createdAt: f.createdAt,
        });
      },
      update: async (f) => {
        await tx
          .update(folders)
          .set({
            name: f.name,
            path: f.path,
            parentFolderId: f.parentFolderId,
          })
          .where(and(eq(folders.id, f.id), eq(folders.orgId, orgId)));
      },
      archive: async (folderId, at, by) => {
        await tx
          .update(folders)
          .set({ archivedAt: at, archivedBy: by ?? null })
          .where(and(eq(folders.id, folderId), eq(folders.orgId, orgId)));
      },
      restore: async (folderId) => {
        await tx
          .update(folders)
          .set({ archivedAt: null, archivedBy: null })
          .where(and(eq(folders.id, folderId), eq(folders.orgId, orgId)));
      },
      findById: async (id) => {
        const [r] = await tx
          .select()
          .from(folders)
          .where(and(eq(folders.id, id), eq(folders.orgId, orgId)))
          .limit(1);
        return r ? toFolder(r) : null;
      },
      findBySlugInBrain: async (brainId, slug) => {
        const [r] = await tx
          .select()
          .from(folders)
          .where(
            and(
              eq(folders.brainId, brainId),
              eq(folders.slug, slug),
              eq(folders.orgId, orgId),
            ),
          )
          .limit(1);
        return r ? toFolder(r) : null;
      },
      findByRepoName: async (repoName) => {
        const [r] = await tx
          .select()
          .from(folders)
          .where(and(eq(folders.repoName, repoName), eq(folders.orgId, orgId)))
          .limit(1);
        return r ? toFolder(r) : null;
      },
      listByBrain: async (brainId) => {
        const rows = await tx
          .select()
          .from(folders)
          .where(and(eq(folders.brainId, brainId), eq(folders.orgId, orgId)))
          .orderBy(desc(folders.createdAt));
        return rows.map(toFolder);
      },
      listByOrg: async () => {
        const rows = await tx
          .select()
          .from(folders)
          .where(eq(folders.orgId, orgId))
          .orderBy(desc(folders.createdAt));
        return rows.map(toFolder);
      },
    },

    tokens: {
      add: async (t) => {
        await tx.insert(accessTokens).values({
          id: t.id,
          orgId: t.orgId,
          subjectType: t.subjectType,
          subjectId: t.subjectId,
          name: t.name,
          tokenPrefix: t.tokenPrefix,
          hashedSecret: t.hashedSecret,
          scopes: t.scopes ?? null,
          createdAt: t.createdAt,
          expiresAt: t.expiresAt,
          lastUsedAt: t.lastUsedAt,
          revokedAt: t.revokedAt,
        });
      },
      listBySubject: async (subjectId) => {
        const rows = await tx
          .select()
          .from(accessTokens)
          .where(
            and(
              eq(accessTokens.subjectId, subjectId),
              eq(accessTokens.orgId, orgId),
            ),
          )
          .orderBy(desc(accessTokens.createdAt));
        return rows.map(toAccessToken);
      },
      revoke: async (tokenId, at) => {
        await tx
          .update(accessTokens)
          .set({ revokedAt: at })
          .where(
            and(eq(accessTokens.id, tokenId), eq(accessTokens.orgId, orgId)),
          );
      },
    },

    grants: {
      grant: async (g) => {
        await tx
          .insert(folderAccess)
          .values({
            orgId: g.orgId,
            folderId: g.folderId,
            userId: g.userId,
            permission: g.permission,
          })
          .onConflictDoUpdate({
            target: [folderAccess.folderId, folderAccess.userId],
            set: { permission: g.permission },
          });
      },
      revoke: async (folderId, userId) => {
        await tx
          .delete(folderAccess)
          .where(
            and(
              eq(folderAccess.folderId, folderId),
              eq(folderAccess.userId, userId),
              eq(folderAccess.orgId, orgId),
            ),
          );
      },
      find: async (folderId, userId) => {
        const [r] = await tx
          .select()
          .from(folderAccess)
          .where(
            and(
              eq(folderAccess.folderId, folderId),
              eq(folderAccess.userId, userId),
              eq(folderAccess.orgId, orgId),
            ),
          )
          .limit(1);
        return r ? toGrant(r) : null;
      },
      listByFolder: async (folderId) => {
        const rows = await tx
          .select()
          .from(folderAccess)
          .where(
            and(eq(folderAccess.folderId, folderId), eq(folderAccess.orgId, orgId)),
          );
        return rows.map(toGrant);
      },
      listByUser: async (userId) => {
        const rows = await tx
          .select()
          .from(folderAccess)
          .where(
            and(eq(folderAccess.userId, userId), eq(folderAccess.orgId, orgId)),
          );
        return rows.map(toGrant);
      },
    },

    groups: {
      create: async (g) => {
        await tx.insert(accessGroups).values({
          id: g.id,
          orgId: g.orgId,
          name: g.name,
          slug: g.slug,
          createdAt: g.createdAt,
        });
      },
      rename: async (groupId, name) => {
        await tx
          .update(accessGroups)
          .set({ name })
          .where(
            and(eq(accessGroups.id, groupId), eq(accessGroups.orgId, orgId)),
          );
      },
      delete: async (groupId) => {
        // group_members and group_grants cascade via their FKs to access_groups.
        await tx
          .delete(accessGroups)
          .where(
            and(eq(accessGroups.id, groupId), eq(accessGroups.orgId, orgId)),
          );
      },
      findById: async (groupId) => {
        const [r] = await tx
          .select()
          .from(accessGroups)
          .where(
            and(eq(accessGroups.id, groupId), eq(accessGroups.orgId, orgId)),
          )
          .limit(1);
        return r ? toGroup(r) : null;
      },
      findBySlug: async (slug: Slug) => {
        const [r] = await tx
          .select()
          .from(accessGroups)
          .where(
            and(eq(accessGroups.slug, slug), eq(accessGroups.orgId, orgId)),
          )
          .limit(1);
        return r ? toGroup(r) : null;
      },
      listByOrg: async () => {
        const rows = await tx
          .select()
          .from(accessGroups)
          .where(eq(accessGroups.orgId, orgId));
        return rows.map(toGroup);
      },
      addMember: async (groupId, userId) => {
        await tx
          .insert(groupMembers)
          .values({ orgId, groupId, userId })
          // Idempotent: re-adding a member is a no-op.
          .onConflictDoNothing({
            target: [groupMembers.groupId, groupMembers.userId],
          });
      },
      removeMember: async (groupId, userId) => {
        await tx
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, groupId),
              eq(groupMembers.userId, userId),
              eq(groupMembers.orgId, orgId),
            ),
          );
      },
      listMembers: async (groupId): Promise<GroupMember[]> => {
        const rows = await tx
          .select({
            orgId: groupMembers.orgId,
            groupId: groupMembers.groupId,
            userId: groupMembers.userId,
          })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, groupId),
              eq(groupMembers.orgId, orgId),
            ),
          );
        return rows;
      },
      listGroupsForUser: async (userId) => {
        const rows = await tx
          .select({
            id: accessGroups.id,
            orgId: accessGroups.orgId,
            name: accessGroups.name,
            slug: accessGroups.slug,
            createdAt: accessGroups.createdAt,
          })
          .from(accessGroups)
          .innerJoin(groupMembers, eq(groupMembers.groupId, accessGroups.id))
          .where(
            and(
              eq(groupMembers.userId, userId),
              eq(accessGroups.orgId, orgId),
            ),
          );
        return rows.map(toGroup);
      },
      grant: async (g) => {
        await tx
          .insert(groupGrants)
          .values({
            orgId: g.orgId,
            groupId: g.groupId,
            folderId: g.folderId,
            permission: g.permission,
          })
          .onConflictDoUpdate({
            target: [groupGrants.groupId, groupGrants.folderId],
            set: { permission: g.permission },
          });
      },
      revoke: async (groupId, folderId) => {
        await tx
          .delete(groupGrants)
          .where(
            and(
              eq(groupGrants.groupId, groupId),
              eq(groupGrants.folderId, folderId),
              eq(groupGrants.orgId, orgId),
            ),
          );
      },
      findGrant: async (groupId, folderId) => {
        const [r] = await tx
          .select()
          .from(groupGrants)
          .where(
            and(
              eq(groupGrants.groupId, groupId),
              eq(groupGrants.folderId, folderId),
              eq(groupGrants.orgId, orgId),
            ),
          )
          .limit(1);
        return r ? toGroupGrant(r) : null;
      },
      listGrants: async (groupId) => {
        const rows = await tx
          .select()
          .from(groupGrants)
          .where(
            and(
              eq(groupGrants.groupId, groupId),
              eq(groupGrants.orgId, orgId),
            ),
          );
        return rows.map(toGroupGrant);
      },
      listGrantsByFolder: async (folderId) => {
        const rows = await tx
          .select()
          .from(groupGrants)
          .where(
            and(
              eq(groupGrants.folderId, folderId),
              eq(groupGrants.orgId, orgId),
            ),
          );
        return rows.map(toGroupGrant);
      },
    },

    audit: {
      record: async (e) => {
        await tx.insert(auditLog).values({
          orgId: e.orgId,
          actorId: e.actorId ?? null,
          action: e.action,
          target: e.target ?? null,
          metadata: e.metadata ?? null,
        });
      },
    },

    snapshots: {
      add: async (s) => {
        await tx.insert(brainSnapshots).values({
          id: s.id,
          orgId: s.orgId,
          brainId: s.brainId,
          label: s.label,
          createdBy: s.createdBy,
          entries: s.entries,
          createdAt: s.createdAt,
        });
      },
      findById: async (id) => {
        const [r] = await tx
          .select()
          .from(brainSnapshots)
          .where(and(eq(brainSnapshots.id, id), eq(brainSnapshots.orgId, orgId)))
          .limit(1);
        return r ? toBrainSnapshot(r) : null;
      },
      listByBrain: async (brainId) => {
        const rows = await tx
          .select()
          .from(brainSnapshots)
          .where(
            and(
              eq(brainSnapshots.brainId, brainId),
              eq(brainSnapshots.orgId, orgId),
            ),
          )
          .orderBy(desc(brainSnapshots.createdAt));
        return rows.map(toBrainSnapshot);
      },
    },
  };
}
