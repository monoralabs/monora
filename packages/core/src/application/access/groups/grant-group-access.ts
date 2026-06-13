import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";
import type { Permission } from "../../../domain/access/permission";
import { collectSubtree } from "../../../domain/workspace/descendants";

export interface GrantGroupAccessDeps {
  uow: UnitOfWork;
}

export interface GrantGroupAccessInput {
  orgId: string;
  groupId: string;
  folderId: string;
  permission: Permission;
  actorId?: string | null;
  /** Also grant on every folder nested under `folderId` in its brain (the
   *  CURRENT tree). A one-time bulk-apply, not live inheritance: folders created
   *  later stay private to the group - same semantics as a direct grant. */
  includeDescendants?: boolean;
}

/** Add (or change) a folder grant on a group. Every member's effective access
 *  picks it up on their next read - no per-user backfill. Idempotent upsert. */
export function grantGroupAccess(deps: GrantGroupAccessDeps) {
  return (input: GrantGroupAccessInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        const group = await repos.groups.findById(input.groupId);
        if (!group) throw DomainError.notFound("Group not found");

        let targets = [input.folderId];
        if (input.includeDescendants) {
          const root = await repos.folders.findById(input.folderId);
          if (!root) throw DomainError.notFound("Folder not found");
          const siblings = await repos.folders.listByBrain(root.brainId);
          targets = collectSubtree(siblings, input.folderId);
        }
        for (const folderId of targets) {
          const existing = await repos.groups.findGrant(input.groupId, folderId);
          await repos.groups.grant({
            orgId: input.orgId,
            groupId: input.groupId,
            folderId,
            permission: input.permission,
          });
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: existing ? "group.change" : "group.grant",
            target: folderId,
            metadata: { groupId: input.groupId, permission: input.permission },
          });
        }
      });
    });
}
