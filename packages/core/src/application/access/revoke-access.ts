import { asResult } from "../../shared/errors";
import { DomainError } from "../../shared/errors";
import type { Result } from "../../shared/result";
import type { UnitOfWork } from "../../domain/uow";
import { collectSubtree } from "../../domain/workspace/descendants";

export interface RevokeAccessDeps {
  uow: UnitOfWork;
}

export interface RevokeAccessInput {
  orgId: string;
  folderId: string;
  userId: string;
  actorId?: string | null;
  /** Also revoke on every folder nested under `folderId` in its brain (the
   *  CURRENT tree), so removing access to a parent doesn't leave orphaned
   *  subfolders the user can still reach. */
  includeDescendants?: boolean;
}

/** Remove a user's access to a folder. Their next connector sync drops the
 *  folder from their tree. */
export function revokeAccess(deps: RevokeAccessDeps) {
  return (input: RevokeAccessInput): Promise<Result<void, DomainError>> =>
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
          await repos.grants.revoke(folderId, input.userId);
          await repos.audit.record({
            orgId: input.orgId,
            actorId: input.actorId ?? null,
            action: "access.revoke",
            target: folderId,
            metadata: { userId: input.userId },
          });
        }
      });
    });
}
