import { DomainError } from "../../shared/errors";
import type { Slug } from "../workspace/slug";
import type { Permission } from "./permission";

/**
 * A named bundle of folder grants inside an org (e.g. "Sales", "Finance").
 * Assigning a user to a group gives them the group's grants; their EFFECTIVE
 * access is the MAX over every group they belong to plus any direct grant
 * (see `maxPermission`). Adding/removing a folder from a group propagates to all
 * members at once, which is the whole point - onboarding stops being per-user
 * folder-by-folder. Org-scoped: one set of groups per org.
 */
export interface AccessGroup {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: Slug;
  readonly createdAt: Date;
}

/** A user's membership in a group. Maps 1:1 to a group_members row. */
export interface GroupMember {
  readonly orgId: string;
  readonly groupId: string;
  readonly userId: string;
}

/** A grant a group holds on a folder. Maps 1:1 to a group_grants row. Same
 *  shape as a direct AccessGrant, but keyed by group rather than user. */
export interface GroupGrant {
  readonly orgId: string;
  readonly groupId: string;
  readonly folderId: string;
  readonly permission: Permission;
}

export function createGroup(input: {
  id: string;
  orgId: string;
  name: string;
  slug: Slug;
  createdAt: Date;
}): AccessGroup {
  const name = input.name.trim();
  if (name === "") {
    throw DomainError.validation("Group name cannot be empty");
  }
  return {
    id: input.id,
    orgId: input.orgId,
    name,
    slug: input.slug,
    createdAt: input.createdAt,
  };
}

/**
 * Groups, their membership, and their folder grants. Three concerns behind one
 * port so a use-case touches them in a single transaction. The authz adapter
 * reads `members` x `grants` to fold group access into `can`/`levelFor`.
 */
export interface GroupRepository {
  create(group: AccessGroup): Promise<void>;
  rename(groupId: string, name: string): Promise<void>;
  /** Cascades (FK) to the group's memberships and grants. */
  delete(groupId: string): Promise<void>;
  findById(groupId: string): Promise<AccessGroup | null>;
  findBySlug(slug: Slug): Promise<AccessGroup | null>;
  listByOrg(): Promise<AccessGroup[]>;

  /** Idempotent: re-adding an existing member is a no-op. */
  addMember(groupId: string, userId: string): Promise<void>;
  removeMember(groupId: string, userId: string): Promise<void>;
  listMembers(groupId: string): Promise<GroupMember[]>;
  listGroupsForUser(userId: string): Promise<AccessGroup[]>;

  /** Upsert: one grant per (group, folder); re-granting changes the level. */
  grant(grant: GroupGrant): Promise<void>;
  revoke(groupId: string, folderId: string): Promise<void>;
  findGrant(groupId: string, folderId: string): Promise<GroupGrant | null>;
  listGrants(groupId: string): Promise<GroupGrant[]>;
  listGrantsByFolder(folderId: string): Promise<GroupGrant[]>;
}
