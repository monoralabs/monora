import { asResult } from "../../../shared/errors";
import { DomainError } from "../../../shared/errors";
import type { Result } from "../../../shared/result";
import type { UnitOfWork } from "../../../domain/uow";
import { collectSubtree } from "../../../domain/workspace/descendants";

export interface RevokeGroupAccessDeps {
  uow: UnitOfWork;
}

export interface RevokeGroupAccessInput {
  orgId: string;
  groupId: string;
  folderId: string;
  actorId?: string | null;
  /** Also revoke on every folder nested under `folderId` in its brain (the
   *  CURRENT tree). */
  includeDescendants?: boolean;
}

/** Remove a folder grant from a group. Members who reached the folder ONLY
 *  through this grant lose it on their next read; members with a direct grant or
 *  another group keep it (effective access is the union/MAX). This is the
 *  "remove a folder from a group and it propagates to everyone" half. */
export function revokeGroupAccess(deps: RevokeGroupAccessDeps) {
  return (input: RevokeGroupAccessInput): Promise<Result<void, DomainError>> =>
    asResult(async () => {
      await deps.uow.run(input.orgId, async (repos) => {
        let targets = [input.folderId];
        if (input.includeDescendants) {
          const root = await repos.folders.findById(input.folderId);
          if (!root) throw DomainError.notFound("Folder not found");
          const siblings = await repos.folders.listByBrain(root.brainId);
          targets = collectSubtree(siblings, input.folderId);
        }
        for (const folderId of targets) {
          await repos.groups.revoke(input.groupId, folderId);
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: "group.revoke",
            target: folderId,
            metadata: { groupId: input.groupId },
          });
        }
      });
    });
}
